'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseAllowlist, parseWriteRules, requestIdFor, isWriteAllowed } = require('./lib/guard');
const { createIoBrokerExtension } = require('./lib/tools');
const { createModelsWithKey, listModels, testModel } = require('./lib/providers');
const {
    SYSTEM_AI_OBJECT_ID,
    keySourceOf,
    usesSystemAi,
    systemAiForm,
    systemAiFingerprint,
    readSystemAi,
    resolveApiKey,
} = require('./lib/credentials');
const { ensureObjects } = require('./lib/objects');
const { openStore } = require('./lib/store');
const {
    BACKUP_DIR,
    STORE_FILE,
    backupName,
    isBackupName,
    sortBackupsNewestFirst,
    selectLocalBackupsToPrune,
    backupLabel,
    createSnapshot,
    stageRestore,
    applyPendingRestore,
} = require('./lib/backup');
const { autoBackupDelay } = require('./lib/backup-schedule');
const { queuedPurges, queuePurge, purgeQueued } = require('./lib/purge');
const { createMemory } = require('./lib/memory');
const { createWatches } = require('./lib/watches');
const { findLogFile } = require('./lib/diagnostics');
const {
    OUTPUT_LINES,
    VERSION,
    compareVersions,
    adapterNameOf,
    repositoryJson,
    installedAdapters,
    updateRefusal,
    npmLatest,
    createHostCommands,
} = require('./lib/updates');
const {
    copyBackupToRemote,
    settingsForConnectionTest,
    testRemoteConnection,
    listRemoteBackups,
    fetchRemoteBackup,
} = require('./lib/remote-backup');
const { connectSsh2 } = require('./lib/sftp-ssh2');

/** Commands of the tab "Backup" of the admin page. */
const BACKUP_COMMANDS = [
    'createBackup',
    'listBackups',
    'restoreBackup',
    'testRemoteBackup',
    'listRemoteBackups',
    'restoreFromRemote',
];
const { resolveTimeZone, timeZoneOptions } = require('./lib/time');
const { channelsFromConfig, legacyRows, chatKey, parseChatKey, migrateChats } = require('./lib/channels');
const { createDrivers, messengerType, MESSENGER_ADAPTERS } = require('./lib/messengers');
const { ADMIN, ADMIN_INSTRUCTIONS, historyOf, withNotices, createAdminChat } = require('./lib/admin-chat');
const { isAllowedUser, stripPrefix, telegramRequestId } = require('./lib/telegram');

/**
 * Text blocks of the model messages of one transcript entry.
 *
 * @param {ReadonlyArray<{ content?: string | ReadonlyArray<{ type: string, text?: string }> }>} messages model messages
 * @returns {string} the text blocks joined by newlines, empty when there are none
 */
function answerText(messages) {
    return messages
        .flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
}

/**
 * Pending requests as stored in chat.pending: a list, or the single object of version 0.0.1.
 *
 * @param {unknown} value state value
 * @returns {Array<{ requestId: string, content: string, target: { kind: string, instance?: string, chatId?: string } }>} entries
 */
function parsePending(value) {
    if (!value) {
        return [];
    }
    const parsed = JSON.parse(String(value));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .filter(e => e && e.requestId && e.content)
        .map(e => ({ requestId: e.requestId, content: e.content, target: chatTarget(e.target) }));
}

/**
 * ioBroker user of a message from the admin tab: the socket of admin passes it in the options of sendTo.
 * Without one (authentication off) all admin sessions share one conversation.
 *
 * @param {ioBroker.Message} obj message
 * @returns {string} user id, e.g. "system.user.admin"
 */
function adminUser(obj) {
    const user = String(Object(obj).user || '').trim();
    return /^system\.user\.[^/]+$/.test(user) ? user : 'system.user.admin';
}

/**
 * Target of a stored request; up to 0.0.5 a messenger chat was { kind: "telegram", chatId } without an instance.
 *
 * @param {{ kind: string, instance?: string, chatId?: string } | undefined} target stored target
 * @returns {{ kind: string, instance?: string, chatId?: string }} target
 */
function chatTarget(target) {
    if (!target) {
        return { kind: 'state' };
    }
    return target.kind === 'telegram' ? { ...target, kind: 'chat' } : target;
}

/** Longest instructions a sendTo caller may give its conversation, in characters. */
const MAX_CALLER_INSTRUCTIONS = 20000;

/**
 * Target of a sendTo "ask": the root conversation, or a conversation of its own when the caller names one
 * ("conversation"), e.g. one per room of a voice assistant. Such a conversation keeps its own history and
 * takes the instructions the caller sends with it.
 *
 * @param {unknown} from sender of the message, e.g. "system.adapter.assistant.0"
 * @param {{ conversation?: unknown, instructions?: unknown }} message message of the caller
 * @returns {{ kind: 'sendTo', instance?: string, chatId?: string, instructions?: string }} target
 */
function sendToTarget(from, message) {
    // "/" separates instance and chat in the key of telegram.chats
    const conversation = String(message.conversation ?? '')
        .trim()
        .replace(/\//g, '_')
        .slice(0, 100);
    if (!conversation) {
        return { kind: 'sendTo' };
    }
    const caller = String(from || '')
        .replace(/^system\.adapter\./, '')
        .replace(/\//g, '_');
    const instructions = String(message.instructions ?? '')
        .trim()
        .slice(0, MAX_CALLER_INSTRUCTIONS);
    return {
        kind: 'sendTo',
        instance: `sendTo:${caller || '?'}`,
        chatId: conversation,
        ...(instructions ? { instructions } : {}),
    };
}

class PiAgent extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'pi-agent' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        // one handler for all watched objects (system.ai, fullcalendar instances), registered once
        this.on('objectChange', this.onObjectChange.bind(this));

        this.harness = null;
        this.root = null;
        this.context = null;
        this.model = null;
        /** Provider settings the agent works with: from this instance or from system.ai (see providerSettings). */
        this.settings = null;
        /** Instructions of the conversations of sendTo callers, as last configured ("<key>" -> text). */
        this.callerInstructions = new Map();
        this.allowlist = [];
        /** IANA time zone of the house (setting, else the server's). */
        this.timeZone = 'UTC';
        /** States whose write the user must confirm in the messenger chat first. */
        this.confirmList = [];
        /** Messenger instances the agent listens on ("telegram.0" -> allowed users and prefix); empty when off. */
        this.channels = new Map();
        /** Sending, reading and confirming per messenger adapter (telegram, max). */
        this.drivers = createDrivers(this);
        /** Questions, errors and reminders of the chat in the admin tab, per ioBroker user. */
        this.adminChat = createAdminChat(this);
        /** Long-term memory shared by all conversations (lib/memory.js). */
        this.memory = createMemory(this, () => this.config.longTermMemory !== false);
        /** Watches of notify_when (lib/watches.js); they tell the chat of their conversation like a reminder. */
        this.watches = createWatches(this, (conversationId, text) => this.deliverReminder(conversationId, text));
        /** Instances with "Restart allowed" in the write permissions. */
        this.restartList = [];
        /** How long a restarted instance may take to run again. */
        this.restartWaitMs = 45_000;
        /** Enabled instances of the scheduler adapter fullcalendar, e.g. ["fullcalendar.0"]. */
        this.schedulers = [];
        /** Commands on the host (updates of adapters) and their output. */
        this.hostCommands = createHostCommands(this);
        /** fetch for the npm registry, replaceable in tests. */
        this.fetch = globalThis.fetch;
        /** Users of the admin tab whose request runs now (requests resumed after a restart are in this.pending). */
        this.adminRunning = new Set();
        /** "<instance>/<chat id>" -> conversation id, persisted in telegram.chats. */
        this.chats = {};
        /** Requests that were accepted but not answered yet, persisted in chat.pending. */
        this.pending = [];
        this.pendingWrite = Promise.resolve();
        /** Set in onUnload: errors from the closing harness are interruptions, not failures. */
        this.stopping = false;
        /** One queue per conversation ("root" or "<instance>/<chat id>"): runs of one conversation are serialised. */
        this.queues = new Map();
        /** Next automatic backup of the conversations (a timer). */
        this.backupTimer = undefined;
        /** Copies to the SFTP server, one after the other. */
        this.remoteQueue = Promise.resolve();
        this.readyPromise = new Promise(resolve => {
            this.markReady = resolve;
        });
    }

    async onReady() {
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            if (
                (await this.enableMessagebox()) ||
                (await this.migrateMessengerSettings()) ||
                (await this.removeObsoleteSettings())
            ) {
                this.markReady();
                return; // js-controller restarts the instance because its object changed
            }
            // Created here, not in instanceObjects: js-controller would reset their ACL at every start.
            await ensureObjects(this);
            // a backup chosen for restore replaces the store before anything opens it
            await this.applyRestore();
            await this.memory.load();
            await this.watchSchedulers();
            // the user may edit the facts in the state memory.list
            await this.subscribeStatesAsync('memory.list');
            // the table "Write permissions" and the regular expressions of the expert fields both count
            const rules = parseWriteRules(this.config.writeRules);
            this.restartList = rules.restart;
            this.allowlist = [
                ...rules.allow,
                ...parseAllowlist(this.config.writeAllow, (line, msg) =>
                    this.log.warn(`Ignoring invalid allowlist line "${line}": ${msg}`),
                ),
            ];
            this.timeZone = resolveTimeZone(this.config.timeZone, this.log);
            this.log.info(`Time zone: ${this.timeZone}`);
            this.confirmList = [
                ...rules.confirm,
                ...parseAllowlist(this.config.confirmRequired, (line, msg) =>
                    this.log.warn(`Ignoring invalid confirmation line "${line}": ${msg}`),
                ),
            ];
            if (this.allowlist.length === 0) {
                this.log.warn('The write allowlist is empty: the agent can read but not write anything.');
            }
            if (this.config.dryRun) {
                this.log.info('Simulation mode is on: write requests are logged but not executed.');
            }

            this.settings = await this.providerSettings();
            const apiKey = this.settings ? await this.apiKey(this.settings) : null;
            if (apiKey === null) {
                this.markReady();
                return;
            }

            await this.startHarness(apiKey);
            await this.subscribeStatesAsync('chat.input');
            await this.startMessengers();
            // after the chats: a watch that fires at once tells its chat
            await this.watches.load();
            // an update of pi-agent itself restarted the instance: tell the chat that asked for it
            await this.reportSelfUpdate();
            await this.scheduleAutoBackup();
            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.markReady();

            // Requests that were cut off by a restart or a crash are picked up again with the same requestId.
            await this.resumePending();
        } catch (e) {
            this.log.error(`Start failed: ${e.message}`);
            this.markReady();
        }
    }

    /**
     * Versions 0.0.1-0.0.4 declared "supportedMessages": {"custom": false}. When that object exists, js-controller
     * ignores common.messagebox and subscribes to messages only if one of its values is true - so sendTo never
     * arrived. An update does not remove the key from an existing instance object, so it is set to null here, once
     * (a partial update: js-controller takes a supportedMessages that is no object as absent).
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async enableMessagebox() {
        const id = `system.adapter.${this.namespace}`;
        try {
            const obj = await this.getForeignObjectAsync(id);
            const supported = obj?.common && Object(obj.common).supportedMessages;
            if (!supported || typeof supported !== 'object' || Object.values(supported).some(v => v !== false)) {
                return false;
            }
            await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
            this.log.info(
                'Message box enabled: removed an outdated "supportedMessages" from the instance; it restarts once',
            );
            return true;
        } catch (e) {
            this.log.warn(`Could not check the message box setting of the instance: ${e.message}`);
            return false;
        }
    }

    /**
     * Versions up to 0.0.5 had one Telegram instance in three single fields; since 0.1.0 it is a row of the table
     * "messengers". The settings are moved once, so the admin page shows the instance in the table.
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async migrateMessengerSettings() {
        const native = this.config;
        const hasTable = Array.isArray(native.messengers) && native.messengers.length > 0;
        if (hasTable || !String(native.telegramInstance || '').trim()) {
            return false;
        }
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: {
                    messengers: legacyRows(native),
                    telegramInstance: '',
                    telegramUsers: '',
                    telegramPrefix: '',
                },
            });
            this.log.info('Telegram settings moved into the table of messengers; the instance restarts once');
            return true;
        } catch (e) {
            // the single fields keep working: channelsFromConfig reads them while the table is empty
            this.log.warn(`Could not move the Telegram settings into the table: ${e.message}`);
            return false;
        }
    }

    /**
     * A development build before 0.1.0 stored the messenger table as "telegramChannels"; no release reads it.
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async removeObsoleteSettings() {
        // a partial update cannot remove a key: null marks it as removed
        if (Object(this.config).telegramChannels === undefined || Object(this.config).telegramChannels === null) {
            return false;
        }
        const id = `system.adapter.${this.namespace}`;
        try {
            await this.extendForeignObjectAsync(id, { native: { telegramChannels: null } });
            this.log.info('Removed the unused setting "telegramChannels"; the instance restarts once');
            return true;
        } catch (e) {
            this.log.warn(`Could not remove the unused setting "telegramChannels": ${e.message}`);
            return false;
        }
    }

    /**
     * Installed messenger instances (telegram, max) for the instance column of the messenger table.
     *
     * @returns {Promise<Array<{ value: string, label: string }>>} options
     */
    async messengerInstanceOptions() {
        const options = [];
        for (const name of MESSENGER_ADAPTERS) {
            const view = await this.getObjectViewAsync('system', 'instance', {
                startkey: `system.adapter.${name}.`,
                endkey: `system.adapter.${name}.香`,
            });
            for (const row of view.rows) {
                const instance = row.id.slice('system.adapter.'.length);
                const title = Object(row.value?.common?.titleLang).en || row.value?.common?.title;
                options.push({ value: instance, label: title ? `${instance} (${title})` : instance });
            }
        }
        return options;
    }

    /**
     * The table "Write permissions" with a row (nothing allowed yet) for every installed instance that has none.
     * Instances of admin and system tools (adapter type "general" or "storage") and the agent itself are left out.
     *
     * @param {unknown} rows rows of the admin page, not saved yet
     * @returns {Promise<{ rows: Array<{ scope: string, write: boolean, confirm: boolean, restart?: boolean }>, added: number }>} table
     */
    async writeRulesWithInstances(rows) {
        const table = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
        const present = new Set(table.map(r => String(r.scope || '').trim()));
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.香',
        });
        const added = view.rows
            .filter(row => !['general', 'storage'].includes(String(row.value?.common?.type)))
            .map(row => row.id.slice('system.adapter.'.length))
            .filter(instance => instance !== this.namespace && !present.has(instance))
            .sort()
            .map(instance => ({ scope: instance, write: false, confirm: false, restart: false }));
        return { rows: [...table, ...added], added: added.length };
    }

    /**
     * The provider settings the agent works with: those of this instance, or the system-wide AI settings of admin
     * (system.ai, see usesSystemAi). With the system-wide settings, system.ai is watched: a change restarts the instance.
     *
     * @returns {Promise<{ provider: string, modelId: string, baseUrl: string, keySource: string, apiKey: string, credentialId: string } | null>} settings, null when the agent stays idle
     */
    async providerSettings() {
        const own = {
            provider: String(this.config.provider || ''),
            modelId: String(this.config.modelId || '').trim(),
            baseUrl: String(this.config.baseUrl || '').trim(),
            keySource: keySourceOf(this.config),
            apiKey: String(this.config.apiKey || '').trim(),
            credentialId: String(this.config.credentialId || '').trim(),
        };
        if (!usesSystemAi(this.config)) {
            return own;
        }
        const obj = await readSystemAi(this);
        await this.watchSystemAi(obj);
        const form = systemAiForm(obj?.native);
        if (form) {
            this.log.info(`Using the system-wide AI settings of admin (${SYSTEM_AI_OBJECT_ID})`);
            return form;
        }
        if (keySourceOf(this.config) === 'adapter') {
            return own; // nothing configured anywhere: apiKey() says that the key is missing
        }
        this.log.warn(
            'The system-wide AI settings have no provider. Set them up in admin (System settings, tab "AI") or choose another key source; the agent stays idle until then.',
        );
        return null;
    }

    /**
     * Restart the instance when the provider, model, base URL or credential of system.ai changes.
     *
     * @param {ioBroker.Object | null} obj system.ai as it is now
     */
    async watchSystemAi(obj) {
        // onObjectChange compares the next version of system.ai with this one
        this.systemAiFingerprint = systemAiFingerprint(obj);
        try {
            await this.subscribeForeignObjectsAsync(SYSTEM_AI_OBJECT_ID);
        } catch (e) {
            this.log.warn(`Cannot watch ${SYSTEM_AI_OBJECT_ID}: ${e.message}`);
        }
    }

    /**
     * The API key of the provider settings, from this instance or from the central credential store of admin.
     * A key of the central store is watched: when it changes, the instance restarts with the new one.
     *
     * @param {{ provider: string, keySource: string, apiKey: string, credentialId: string }} settings provider settings
     * @returns {Promise<string | null>} the key (empty for a custom server without one), null when the agent stays idle
     */
    async apiKey(settings) {
        const central = settings.keySource === 'central';
        const system = usesSystemAi(this.config);
        const credentialId = settings.credentialId;
        let key = '';
        try {
            key = await resolveApiKey(this, settings);
        } catch (e) {
            this.log.warn(`Cannot read the credential "${credentialId}": ${e.message}; the agent stays idle`);
            return null;
        }
        if (central && credentialId) {
            await this.watchCredential(credentialId);
        }
        if (!key && settings.provider !== 'custom') {
            // A setting the user still has to make, not a fault: stay idle and say what is missing.
            let hint = 'No API key configured. Enter it in the instance settings';
            if (system && central) {
                hint =
                    'The system-wide AI settings name no credential with an API key. Choose it in admin (System settings, tab "AI")';
            } else if (central) {
                hint = 'No credential with an API key chosen. Choose it in the instance settings';
            }
            this.log.warn(`${hint}; the agent stays idle until then.`);
            return null;
        }
        return key;
    }

    /**
     * Restart the instance when the chosen credential of the central store is changed or deleted.
     *
     * @param {string} credentialId id of the credential, e.g. "system.credentials.openai"
     */
    async watchCredential(credentialId) {
        try {
            const { subscribeCredentials } = require('@iobroker/adapter-core/credentials');
            await subscribeCredentials(this, credentialId, () => {
                if (this.stopping) {
                    return;
                }
                this.log.info(`The credential ${credentialId} was changed; the instance restarts`);
                this.restart();
            });
        } catch (e) {
            this.log.warn(`Cannot watch the credential ${credentialId}: ${e.message}`);
        }
    }

    /**
     * Load the ESM packages and open the durable harness on the instance data directory.
     *
     * @param {string} apiKey API key of the provider (may be empty for a custom server)
     */
    async startHarness(apiKey) {
        const { provider, modelId: configuredModel, baseUrl } = this.settings;
        if (provider === 'custom' && !configuredModel) {
            throw new Error('No model configured for the OpenAI-compatible server');
        }
        // The key goes into an in-memory credential store of this instance, never into the process environment.
        const { spec, models } = await createModelsWithKey(provider, apiKey, { baseUrl, modelId: configuredModel });
        const modelId = configuredModel || spec.defaultModel;

        const [{ BACKGROUND_CONTEXT }, durable, ai] = await Promise.all([
            import('@earendil-works/chord/context'),
            import('@earendil-works/pi-durable'),
            import('@earendil-works/pi-ai'),
        ]);
        this.context = BACKGROUND_CONTEXT;

        const registry = durable.createRegistry();
        registry.install(
            createIoBrokerExtension(this, { ...durable, Type: ai.Type }, () => ({
                allowlist: this.allowlist,
                confirmList: this.confirmList,
                timeZone: this.timeZone,
                dryRun: Boolean(this.config.dryRun),
                instructions: String(this.config.instructions || ''),
                requestConfirmation: request => this.requestConfirmation(request),
                deliverReminder: (conversationId, text) => this.deliverReminder(conversationId, text),
                historyInstance: () => this.historyInstance(),
                restartList: this.restartList,
                restartInstance: instance => this.restartInstance(instance),
                memory: this.memory,
                watches: this.watches,
                scheduled: {
                    tasks: conversationId => this.plannedTasks(conversationId),
                    cancel: (conversationId, id) => this.cancelPlanned(conversationId, id),
                },
                logFile: () => findLogFile(utils.getAbsoluteDefaultDataDir()),
                schedulers: () => this.schedulers,
                updates: {
                    list: () => this.listUpdates(),
                    npm: name => this.npmVersions(name),
                    plan: (name, version, source) => this.planUpdate(name, version, source),
                    run: (plan, conversationId) => this.runUpdate(plan, conversationId),
                },
            })),
        );

        const stored = await this.getStateAsync('chat.pending');
        let pendingCount = 0;
        try {
            pendingCount = parsePending(stored?.val).length;
        } catch {
            // an unreadable list is dropped later by resumePending
        }
        await this.purgeConversations();
        const { storage, migrated } = await openStore(utils.getAbsoluteInstanceDataDir(this), this.context, {
            pendingCount,
            log: this.log,
        });
        if (migrated) {
            // the chats' conversations lived in the old store
            await this.setStateAsync('telegram.chats', { val: '', ack: true });
        }
        this.harness = await durable.Harness.open(storage, { models, registry }, this.context);

        this.model = { provider, modelId };
        this.root = await this.harness.root(this.context, { agent: { model: this.model } });
        await this.root.configure({ model: this.model }, this.context); // the model may have changed since the last start
        this.harness.resume();
        await this.updateUsage();
        this.log.info(`Agent ready (${this.model.provider}/${this.model.modelId})`);
    }

    /** Listen to the configured messenger instances, if any. */
    async startMessengers() {
        this.channels = new Map();
        for (const channel of channelsFromConfig(this.config)) {
            const driver = this.drivers[messengerType(channel.instance)];
            if (driver) {
                this.channels.set(channel.instance, { ...channel, driver });
            } else {
                this.log.warn(
                    `Messenger ${channel.instance} ignored: only ${MESSENGER_ADAPTERS.join(' and ')} are supported`,
                );
            }
        }
        // the chats of the admin tab live in the same map, so it is read even without a messenger
        const stored = await this.getStateAsync('telegram.chats');
        const { chats, changed } = migrateChats(stored?.val ? JSON.parse(String(stored.val)) : {}, this.firstChannel());
        this.chats = chats;
        if (changed) {
            await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
        }
        // Chats keep their own conversation; a model change in the settings reaches them too.
        for (const [key, id] of Object.entries(this.chats)) {
            const instructions = this.instructionsOf(parseChatKey(key, this.firstChannel()).instance);
            const conversation = instructions ? await this.harness.conversation(id, this.context) : undefined;
            await conversation?.configure({ model: this.model, instructions }, this.context);
        }
        for (const { instance, allowed, prefix, driver } of this.channels.values()) {
            if (allowed.size === 0) {
                this.log.warn(`${driver.label} ${instance}: no user is allowed, every message is ignored.`);
            }
            await this.subscribeForeignStatesAsync(`${instance}.communicate.request`);
            this.log.info(
                `${driver.label}: listening on ${instance} for ${allowed.size} allowed user(s)${prefix ? `, prefix "${prefix}"` : ''}`,
            );
        }
    }

    /**
     * @param {string} instance messenger instance, or "admin" for the chat of the admin tab
     * @returns {string | undefined} instructions of its conversations; undefined for an instance that is off
     */
    instructionsOf(instance) {
        return instance === ADMIN ? ADMIN_INSTRUCTIONS : this.channels.get(instance)?.driver.instructions;
    }

    /** @returns {string} first configured messenger instance, or "" (the one of chats stored by 0.0.5) */
    firstChannel() {
        return this.channels.keys().next().value || '';
    }

    /**
     * Conversation of a request: one per messenger chat (per instance), per user of the admin tab and per
     * conversation a sendTo caller names, the root conversation for everything else.
     *
     * @param {{ kind: string, instance?: string, chatId?: string, instructions?: string }} target where the answer goes
     * @returns {Promise<object>} conversation handle
     */
    async conversationFor(target) {
        const key = this.chatKeyOf(target);
        if (!key) {
            return this.root;
        }
        const instance = target.kind === 'admin' ? ADMIN : target.instance;
        // a sendTo caller brings the instructions of its conversation along (e.g. "short, spoken answers", a list of the devices)
        const instructions =
            target.kind === 'sendTo' ? target.instructions || undefined : this.instructionsOf(instance);
        const known = this.chats[key];
        if (known) {
            const conversation = await this.harness.conversation(known, this.context);
            if (conversation) {
                if (target.kind === 'sendTo' && instructions && this.callerInstructions.get(key) !== instructions) {
                    await conversation.configure({ model: this.model, instructions }, this.context);
                    this.callerInstructions.set(key, instructions);
                }
                return conversation;
            }
        }
        const created = await this.harness.createConversation(
            { ownership: { kind: 'ownerless' }, agent: { model: this.model, instructions } },
            this.context,
        );
        if (target.kind === 'sendTo' && instructions) {
            this.callerInstructions.set(key, instructions);
        }
        this.chats[key] = created.id;
        // chats run in parallel; chained writes always store the newest map
        this.chatsWrite = (this.chatsWrite || Promise.resolve())
            .then(async () => {
                await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
            })
            .catch(e => {
                this.log.warn(`Messenger chats could not be saved: ${e.message}`);
            });
        await this.chatsWrite;
        this.log.info(`New conversation for chat ${target.chatId} on ${instance}`);
        return created;
    }

    /**
     * Key of a target in telegram.chats (also the key of its queue).
     *
     * @param {{ kind: string, instance?: string, chatId?: string }} target where the answer goes
     * @returns {string} "<instance>/<chat id>", "admin/<user>", "sendTo:<caller>/<conversation>", or "" for the root conversation
     */
    chatKeyOf(target) {
        if (target.kind === 'admin') {
            return chatKey(ADMIN, target.chatId);
        }
        if (target.kind === 'sendTo') {
            // a sendTo request without a conversation of its own goes to the root conversation, as up to 0.3.0
            return target.instance && target.chatId ? chatKey(target.instance, target.chatId) : '';
        }
        return target.kind === 'chat' ? chatKey(target.instance, target.chatId) : '';
    }

    /**
     * ioBroker user of the admin tab whose conversation this is.
     *
     * @param {unknown} conversationId conversation id
     * @returns {string | undefined} user
     */
    adminUserOf(conversationId) {
        const key = Object.keys(this.chats).find(k => String(this.chats[k]) === String(conversationId));
        const chat = key ? parseChatKey(key, '') : undefined;
        return chat?.instance === ADMIN ? chat.chatId : undefined;
    }

    /**
     * Messenger chat of a conversation, if the conversation belongs to one on a configured instance.
     *
     * @param {unknown} conversationId conversation id
     * @returns {{ instance: string, chatId: string } | undefined} instance and chat
     */
    chatOf(conversationId) {
        const key = Object.keys(this.chats).find(k => String(this.chats[k]) === String(conversationId));
        if (!key) {
            return undefined;
        }
        const chat = parseChatKey(key, this.firstChannel());
        return this.channels.has(chat.instance) ? chat : undefined;
    }

    /**
     * Ask the user in the chat of the conversation whether a write (or the restart of an instance) may happen.
     *
     * @param {{ conversationId: unknown, id: string, val: unknown, action?: string }} request the write to confirm;
     *     with action "restart", id is the instance to restart
     * @returns {Promise<string>} "yes", "no", "timeout" or "unavailable" (no messenger chat for this conversation)
     */
    async requestConfirmation({ conversationId, id, val, action }) {
        const user = this.adminUserOf(conversationId);
        if (user) {
            return this.adminChat.confirm(user, id, val, action);
        }
        const chat = this.chatOf(conversationId);
        if (!chat) {
            this.log.warn(`Confirmation for ${id} needed, but the request did not come from a messenger chat`);
            return 'unavailable';
        }
        try {
            return await this.channels.get(chat.instance).driver.confirm(chat.instance, chat.chatId, id, val, action);
        } catch (e) {
            this.log.warn(`No answer to the confirmation for ${id}: ${e.message}`);
            return 'timeout';
        }
    }

    /**
     * A reminder is due: send it to the messenger chat of its conversation, or to chat.answer.
     *
     * @param {unknown} conversationId conversation that set the reminder
     * @param {string} text reminder text
     */
    async deliverReminder(conversationId, text) {
        const user = this.adminUserOf(conversationId);
        if (user) {
            this.log.info(`Reminder due for the admin chat of ${user}`);
            this.adminChat.addNotice(user, `⏰ ${text}`);
            return;
        }
        const chat = this.chatOf(conversationId);
        const target = chat ? { kind: 'chat', ...chat } : { kind: 'state' };
        this.log.info(`Reminder due${chat ? ` for chat ${chat.chatId} on ${chat.instance}` : ''}`);
        await this.deliver(target, `⏰ ${text}`);
    }

    /** @returns {Promise<string>} configured history instance, else the system default, else "" */
    async historyInstance() {
        const configured = String(this.config.historyInstance || '').trim();
        if (configured) {
            return configured;
        }
        const system = await this.getForeignObjectAsync('system.config');
        return String(system?.common?.defaultHistory || '');
    }

    // ── Backups of the conversations (lib/backup.js, lib/remote-backup.js) ──────────────────────────────

    /**
     * A command of the tab "Backup".
     *
     * @param {string} command one of BACKUP_COMMANDS
     * @param {Record<string, unknown>} message jsonData of the admin page
     * @returns {Promise<object>} answer for the admin page: { result } / { error } or the options of a selection
     */
    async onBackupCommand(command, message) {
        switch (command) {
            case 'createBackup':
                return { result: await this.createBackup('manual') };
            case 'listBackups': {
                const backups = await this.listStoredBackups();
                return backups.length > 0
                    ? backups.map(b => ({ value: b.name, label: backupLabel(b.name, b.size) }))
                    : [{ value: '', label: 'No backup in the storage folder' }];
            }
            case 'restoreBackup':
                return { result: await this.restoreBackup(String(message.file || '')) };
            case 'testRemoteBackup': {
                // an empty password field means the saved password, but only for the saved server
                const settings = settingsForConnectionTest(message, this.remoteSettings());
                const result = await testRemoteConnection(connectSsh2, settings, this.remoteTimers());
                const hint =
                    result.ok && !String(settings.hostKey || '').trim() && result.fingerprint
                        ? ` Fingerprint of the server (enter it to trust only this server): ${result.fingerprint}`
                        : '';
                return result.ok ? { result: `OK: ${result.message}.${hint}` } : { error: result.message };
            }
            case 'listRemoteBackups': {
                const settings = this.remoteSettings();
                if (!settings.enabled) {
                    return [{ value: '', label: 'Switch the copy to the external server on and save first' }];
                }
                const result = await listRemoteBackups(connectSsh2, settings, this.remoteTimers());
                if (!result.ok) {
                    return [{ value: '', label: `Error: ${result.message}` }];
                }
                return result.names.length > 0
                    ? result.names.map(name => ({ value: name, label: backupLabel(name) }))
                    : [{ value: '', label: 'No backup on the server' }];
            }
            case 'restoreFromRemote':
                return { result: await this.restoreFromRemote(String(message.file || '')) };
            default:
                return { error: `Unknown command ${command}` };
        }
    }

    /** @returns {string} id of the mount point of the storage folder, `<namespace>.storage` */
    storageId() {
        return `${this.namespace}.storage`;
    }

    /** @returns {string} path of the conversation store */
    storeFile() {
        return path.join(utils.getAbsoluteInstanceDataDir(this), STORE_FILE);
    }

    /**
     * The backup files in the storage folder, newest first.
     *
     * @returns {Promise<Array<{ name: string, size: number }>>} backups (empty when the folder is missing)
     */
    async listStoredBackups() {
        let entries;
        try {
            entries = await this.readDirAsync(this.storageId(), BACKUP_DIR);
        } catch {
            return [];
        }
        const sizes = new Map(
            (entries || []).filter(e => !e.isDir).map(e => [e.file, Number(e.stats && e.stats.size) || 0]),
        );
        return sortBackupsNewestFirst([...sizes.keys()]).map(name => ({ name, size: Number(sizes.get(name)) }));
    }

    /**
     * Save a backup of the conversations in the storage folder and, when switched on, copy it to the SFTP server.
     *
     * @param {'manual' | 'auto' | 'prerestore' | 'prepurge'} kind made by hand, automatic, or safety copy before a restore or a deletion
     * @returns {Promise<string>} what was done, for the log and the admin page
     */
    async createBackup(kind) {
        const chatsState = await this.getStateAsync('telegram.chats');
        let chats = Object.create(null);
        try {
            chats = chatsState?.val ? JSON.parse(String(chatsState.val)) : {};
        } catch {
            // an unreadable map is not part of the backup
        }
        const { data, rawSize } = createSnapshot(this.storeFile(), { chats, memory: this.memory.list() });
        // meta.user: ioBroker and BackItUp backups take the files of the mount point along
        await this.setForeignObjectNotExistsAsync(this.storageId(), {
            type: 'meta',
            common: { name: 'Pi Agent backups', type: 'meta.user' },
            native: {},
        });
        const now = Date.now();
        const name = backupName(kind, new Date(now));
        await this.writeFileAsync(this.storageId(), `${BACKUP_DIR}/${name}`, data);
        await this.setStateAsync('backup.last', { val: now, ack: true });
        await this.setStateAsync('backup.size', { val: data.length, ack: true });
        const kb = n => `${Math.max(1, Math.round(n / 1024))} kB`;
        let message = `Backup saved: ${this.storageId()}/${BACKUP_DIR}/${name} (${kb(data.length)}, ${kb(rawSize)} uncompressed)`;
        this.log.info(message);
        if (kind === 'auto') {
            await this.pruneStoredBackups();
        }
        if (kind === 'manual' || kind === 'auto') {
            const remote = await this.copyToRemote({ name, data });
            if (remote) {
                message += remote.ok
                    ? `; copied to the external server (${remote.remoteFile})`
                    : `; the copy to the external server FAILED: ${remote.message}`;
            }
        }
        return message;
    }

    /** Delete the oldest automatic backups in the storage folder beyond `backupKeep`. */
    async pruneStoredBackups() {
        const names = (await this.listStoredBackups()).map(b => b.name);
        for (const old of selectLocalBackupsToPrune(names, this.config.backupKeep)) {
            try {
                await this.delFileAsync(this.storageId(), `${BACKUP_DIR}/${old}`);
                this.log.info(`Old automatic backup deleted: ${old}`);
            } catch (e) {
                this.log.warn(`Cannot delete the old backup ${old}: ${e.message}`);
            }
        }
    }

    /**
     * Check a backup and restart the instance, which puts it in place before the store is opened (see onReady).
     * The current conversations are saved first as a safety copy.
     *
     * @param {Buffer} data content of the backup file
     * @param {string} name file name, for the messages
     * @returns {Promise<string>} what was done
     */
    async restoreFrom(data, name) {
        const { conversations, chats } = stageRestore(data, utils.getAbsoluteInstanceDataDir(this));
        let safety = '';
        try {
            safety = await this.createBackup('prerestore');
        } catch (e) {
            // no store yet (a new installation): nothing to keep
            this.log.debug(`No safety copy before the restore: ${e.message}`);
        }
        const message = `Backup ${name} (${conversations} conversation(s), ${chats} chat(s)) is restored at the restart of the instance${safety ? '; the current conversations were saved before' : ''}`;
        this.log.info(message);
        this.setTimeout(() => this.restart(), 1000);
        return message;
    }

    /**
     * Restore a backup of the storage folder.
     *
     * @param {string} name backup file name
     * @returns {Promise<string>} what was done
     */
    async restoreBackup(name) {
        if (!isBackupName(name)) {
            throw new Error('Choose a backup from the list');
        }
        const result = await this.readFileAsync(this.storageId(), `${BACKUP_DIR}/${name}`);
        const file = result && typeof result === 'object' && 'file' in result ? result.file : result;
        return this.restoreFrom(Buffer.isBuffer(file) ? file : Buffer.from(String(file ?? ''), 'binary'), name);
    }

    /**
     * Fetch a backup from the SFTP server into the storage folder and restore it.
     *
     * @param {string} name file name on the server
     * @returns {Promise<string>} what was done
     */
    async restoreFromRemote(name) {
        const settings = this.remoteSettings();
        if (!settings.enabled) {
            throw new Error('Switch the copy to the external server on and save first');
        }
        const fetched = await fetchRemoteBackup(connectSsh2, settings, name, this.remoteTimers());
        if (!fetched.ok || !fetched.data) {
            throw new Error(`Download from the external server failed: ${fetched.message}`);
        }
        await this.setForeignObjectNotExistsAsync(this.storageId(), {
            type: 'meta',
            common: { name: 'Pi Agent backups', type: 'meta.user' },
            native: {},
        });
        await this.writeFileAsync(this.storageId(), `${BACKUP_DIR}/${name}`, fetched.data);
        return this.restoreFrom(fetched.data, name);
    }

    /**
     * Timers for the SFTP copy, so a pending timeout ends with the instance.
     *
     * @returns {{ start: (callback: () => void, ms: number) => ioBroker.Timeout | undefined, stop: (handle: ioBroker.Timeout | undefined) => void }} timers
     */
    remoteTimers() {
        return {
            start: (callback, ms) => this.setTimeout(callback, ms),
            stop: handle => handle && this.clearTimeout(handle),
        };
    }

    /** @returns {object} the instance settings of the copy to the external server, for lib/remote-backup.js */
    remoteSettings() {
        return {
            enabled: this.config.remoteEnabled === true,
            host: this.config.remoteHost,
            port: Number(this.config.remotePort) || undefined,
            username: this.config.remoteUser,
            password: this.config.remotePassword,
            directory: this.config.remoteDirectory,
            hostKey: this.config.remoteHostKey,
            keep: Number(this.config.remoteKeep || 0),
        };
    }

    /**
     * Copy a backup to the external server, when that is switched on. The local backup is already safe at this
     * point: a failed copy is logged and shown in backup.remoteError. Copies run one after the other.
     *
     * @param {{ name: string, data: Buffer }} backup file name on the server and the bytes
     * @returns {Promise<{ ok: boolean, message: string, remoteFile?: string } | null>} the result, or null when the copy is switched off
     */
    copyToRemote(backup) {
        const settings = this.remoteSettings();
        if (!settings.enabled) {
            return Promise.resolve(null);
        }
        const run = async () => {
            const result = await copyBackupToRemote(connectSsh2, settings, backup, this.log, this.remoteTimers());
            if (result.ok) {
                this.log.info(`Backup copied to the external server: ${result.remoteFile}`);
                for (const old of result.deleted) {
                    this.log.info(`Old copy deleted on the external server: ${old}`);
                }
                for (const stale of result.partialsRemoved) {
                    this.log.info(`Interrupted upload removed on the external server: ${stale}`);
                }
                await this.setStateAsync('backup.lastRemote', { val: result.remoteFile || backup.name, ack: true });
                await this.setStateAsync('backup.remoteError', { val: '', ack: true });
            } else {
                this.log.error(`Copy to the external server failed: ${result.message}`);
                await this.setStateAsync('backup.remoteError', { val: result.message, ack: true });
            }
            return result;
        };
        const next = this.remoteQueue.then(run, run);
        this.remoteQueue = next.catch(() => undefined);
        return next;
    }

    /**
     * Plan the next automatic backup from `autoBackupInterval` and the time of the last backup (backup.last, so a
     * restart does not reset the clock). Off when the interval is 0.
     */
    async scheduleAutoBackup() {
        this.clearTimeout(this.backupTimer);
        this.backupTimer = undefined;
        const last = await this.getStateAsync('backup.last');
        const delay = autoBackupDelay(this.config.autoBackupInterval, last ? Number(last.val) : 0);
        if (delay === null || this.stopping) {
            return;
        }
        this.log.debug(`Next automatic backup in ${Math.round(delay / 60_000)} min`);
        this.backupTimer = this.setTimeout(() => void this.runAutoBackup(), delay);
    }

    /** Run one automatic backup; a failure is retried after one hour. */
    async runAutoBackup() {
        this.backupTimer = undefined;
        try {
            await this.createBackup('auto');
        } catch (e) {
            this.log.warn(`Automatic backup failed: ${e.message} — next attempt in one hour`);
            if (!this.stopping) {
                this.backupTimer = this.setTimeout(() => void this.runAutoBackup(), 3_600_000);
            }
            return;
        }
        await this.scheduleAutoBackup();
    }

    /**
     * At the start, before the store is opened: delete the conversations queued by "New conversation" (lib/purge.js),
     * after a safety copy. A failure leaves the store as it was; the agent starts in any case.
     */
    async purgeConversations() {
        const dir = utils.getAbsoluteInstanceDataDir(this);
        if (queuedPurges(dir).length === 0) {
            return;
        }
        try {
            const stored = await this.getStateAsync('telegram.chats');
            const chats = stored?.val ? JSON.parse(String(stored.val)) : {};
            const inUse = new Set(Object.values(Object(chats)).map(String));
            // the safety copy only when something is really deleted, not at every start while a reminder waits
            if (purgeQueued(dir, inUse, { check: true }).deleted.length > 0) {
                await this.createBackup('prepurge');
            }
            const { deleted, waiting, skipped } = purgeQueued(dir, inUse);
            if (skipped) {
                this.log.warn(`Old conversations are not deleted: ${skipped}`);
            } else if (deleted.length > 0) {
                this.log.info(`${deleted.length} old conversation(s) deleted from the store`);
            }
            if (waiting.length > 0) {
                this.log.info(
                    `${waiting.length} old conversation(s) are deleted later: a reminder of theirs is not due yet`,
                );
            }
        } catch (e) {
            this.log.warn(`Old conversations could not be deleted: ${e.message}`);
        }
    }

    /**
     * At the start, before the store is opened: put a backup chosen for restore in place, with its chat map.
     * Requests that were waiting belong to the replaced conversations and are dropped.
     */
    async applyRestore() {
        const restored = applyPendingRestore(utils.getAbsoluteInstanceDataDir(this));
        if (!restored) {
            return;
        }
        await this.setStateAsync('telegram.chats', { val: JSON.stringify(restored.chats), ack: true });
        await this.setStateAsync('chat.pending', { val: '', ack: true });
        if (restored.memory) {
            await this.memory.replace(restored.memory);
        }
        this.log.info(
            `Conversations restored from a backup (${Object.keys(restored.chats).length} chat(s)); waiting requests were dropped`,
        );
    }

    // ── Updates of adapters (lib/updates.js) ──────────────────────────────────────────────────────────

    /**
     * The installed adapters that have a newer version in the active repositories.
     *
     * @returns {Promise<{ repositories: string[], updates: Array<Record<string, unknown>> }>} updates for the model
     */
    async listUpdates() {
        const { names, json } = await repositoryJson(this);
        const updates = [];
        for (const installed of await installedAdapters(this)) {
            const available = String(Object(json[installed.name]).version || '');
            if (available && installed.version && compareVersions(available, installed.version) > 0) {
                const refusal = this.updateRefusalOf(installed);
                updates.push({
                    adapter: installed.name,
                    title: installed.title,
                    installed: installed.version,
                    available,
                    allowed: !refusal,
                    ...(refusal ? { reason: refusal } : {}),
                });
            }
        }
        return { repositories: names, updates };
    }

    /**
     * Why the agent may not update an installed adapter, or "".
     *
     * @param {{ name: string, instances: string[], hosts: string[] }} installed the installed adapter
     * @returns {string} reason, "" when allowed
     */
    updateRefusalOf(installed) {
        const refusal = updateRefusal(installed.name, installed, {
            enabled: this.config.allowUpdates === true,
            own: this.name,
            isAllowed: instance => isWriteAllowed(instance, this.allowlist),
        });
        if (refusal) {
            return refusal;
        }
        if (installed.hosts.length && !installed.hosts.includes(this.host)) {
            return `${installed.name} runs on another host (${installed.hosts.join(', ')}); update it there in admin`;
        }
        return '';
    }

    /**
     * Installed, repository and npm version of an adapter.
     *
     * @param {unknown} value adapter name as the model wrote it
     * @returns {Promise<{ adapter: string, installed: string, repository: string | null, npm: string, newer: boolean }>} versions
     */
    async npmVersions(value) {
        const name = adapterNameOf(value);
        const installed = (await installedAdapters(this)).find(a => a.name === name);
        const { json } = await repositoryJson(this);
        const npm = await npmLatest(name, this.fetch);
        return {
            adapter: name,
            installed: installed?.version || 'not installed',
            repository: String(Object(json[name]).version || '') || null,
            npm,
            newer: Boolean(installed && compareVersions(npm, installed.version) > 0),
        };
    }

    /**
     * What an update would do, or why it may not be done.
     *
     * @param {unknown} value adapter name as the model wrote it
     * @param {unknown} version wanted version, or empty for the one of the source
     * @param {unknown} sourceArg "repository" (default) or "npm"
     * @returns {Promise<{ name: string, from: string, to: string, source: string, refusal: string }>} plan
     */
    async planUpdate(value, version, sourceArg) {
        const name = adapterNameOf(value);
        const source = String(sourceArg || 'repository').toLowerCase() === 'npm' ? 'npm' : 'repository';
        const plan = { name, from: '', to: '', source, refusal: '' };
        const installed = (await installedAdapters(this)).find(a => a.name === name);
        if (!installed) {
            return { ...plan, refusal: `${name} is not installed` };
        }
        plan.from = installed.version;
        const refusal = this.updateRefusalOf(installed);
        if (refusal) {
            return { ...plan, refusal };
        }
        let to = String(version || '').trim();
        if (to && !VERSION.test(to)) {
            return { ...plan, refusal: `"${to}" is no version` };
        }
        if (!to && source === 'repository') {
            to = String(Object((await repositoryJson(this)).json[name]).version || '');
            if (!to) {
                return { ...plan, refusal: `${name} is not in the repository; check_npm shows the version on npm` };
            }
        }
        if (!to) {
            try {
                to = await npmLatest(name, this.fetch);
            } catch (e) {
                return { ...plan, refusal: e.message };
            }
        }
        if (compareVersions(to, installed.version) <= 0) {
            return {
                ...plan,
                to,
                refusal: `${name} ${installed.version} is installed; ${source === 'npm' ? 'npm' : 'the repository'} has no newer version (${to})${source === 'repository' ? '; check_npm shows the version on npm' : ''}`,
            };
        }
        return { ...plan, to };
    }

    /**
     * Run an update on the host and wait for it. An update of pi-agent itself stops this instance: what was asked is
     * kept in update.pending, and the next start tells the chat.
     *
     * @param {{ name: string, from: string, to: string, source: string }} plan checked plan
     * @param {unknown} conversationId conversation that asked
     * @returns {Promise<string>} what happened, for the model
     */
    async runUpdate(plan, conversationId) {
        const self = plan.name === this.name;
        if (self) {
            await this.setStateAsync('update.pending', {
                val: JSON.stringify({ ...plan, conversationId: String(conversationId), ts: Date.now() }),
                ack: true,
            });
        }
        const command =
            plan.source === 'npm' ? `url iobroker.${plan.name}@${plan.to}` : `upgrade ${plan.name}@${plan.to}`;
        const result = await this.hostCommands.run(this.host, command);
        const tail = result.output.filter(Boolean).slice(-OUTPUT_LINES).join('\n');
        if (!result.finished) {
            return `The update of ${plan.name} to ${plan.to} is still running after 10 minutes; it goes on on the host. Tell the user to look at the log. Last output:\n${tail}`;
        }
        if (result.exitCode !== 0) {
            if (self) {
                await this.setStateAsync('update.pending', { val: '', ack: true });
            }
            return `The update of ${plan.name} to ${plan.to} failed (exit code ${result.exitCode}). Last output:\n${tail}`;
        }
        if (plan.source === 'npm' && !self) {
            await this.restartInstancesOf(plan.name);
        }
        const now = (await installedAdapters(this)).find(a => a.name === plan.name)?.version || '?';
        return `${plan.name} was updated from ${plan.from} to ${now} (${plan.source}); its instances restart. Last output:\n${tail}`;
    }

    /**
     * Restart the enabled instances of an adapter after an installation from npm, like admin does.
     *
     * @param {string} name adapter name
     */
    async restartInstancesOf(name) {
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: `system.adapter.${name}.`,
            endkey: `system.adapter.${name}.香`,
        });
        for (const row of view.rows) {
            if (row.value?.common?.enabled) {
                await this.extendForeignObjectAsync(row.id, { common: { enabled: true } });
            }
        }
    }

    /** After an update of pi-agent itself: tell the chat that asked for it whether it worked. */
    async reportSelfUpdate() {
        const stored = (await this.getStateAsync('update.pending'))?.val;
        if (!stored) {
            return;
        }
        await this.setStateAsync('update.pending', { val: '', ack: true });
        let plan;
        try {
            plan = JSON.parse(String(stored));
        } catch {
            return;
        }
        const now = String(this.version || '');
        const done = compareVersions(now, String(plan.to)) >= 0;
        const text = done
            ? `✅ pi-agent was updated from ${plan.from} to ${now} and runs again.`
            : `⚠️ The update of pi-agent to ${plan.to} did not work: version ${now || plan.from} runs. Look at the log of the host.`;
        this.log.info(text);
        await this.deliverReminder(plan.conversationId, text);
    }

    /** Read the enabled instances of the scheduler adapter fullcalendar (the prompt tells the model what it can plan). */
    async refreshSchedulers() {
        try {
            const view = await this.getObjectViewAsync('system', 'instance', {
                startkey: 'system.adapter.fullcalendar.',
                endkey: 'system.adapter.fullcalendar.香',
            });
            this.schedulers = view.rows
                .filter(row => row.value?.common?.enabled !== false)
                .map(row => row.id.slice('system.adapter.'.length))
                .sort();
        } catch (e) {
            this.log.debug(`No list of fullcalendar instances: ${e.message}`);
        }
    }

    /**
     * A watched object changed: system.ai (restart when the provider settings change) or a fullcalendar instance.
     *
     * @param {string} id object id
     * @param {ioBroker.Object | null | undefined} changed the object as it is now, null when deleted
     */
    onObjectChange(id, changed) {
        if (this.stopping) {
            return;
        }
        if (id === SYSTEM_AI_OBJECT_ID) {
            if (this.systemAiFingerprint !== undefined && systemAiFingerprint(changed) !== this.systemAiFingerprint) {
                this.log.info('The system-wide AI settings were changed; the instance restarts');
                this.restart();
            }
            return;
        }
        if (String(id).startsWith('system.adapter.fullcalendar.')) {
            void this.refreshSchedulers();
        }
    }

    /** Keep the list of fullcalendar instances current when one is installed, removed, switched on or off. */
    async watchSchedulers() {
        await this.refreshSchedulers();
        try {
            await this.subscribeForeignObjectsAsync('system.adapter.fullcalendar.*');
        } catch (e) {
            this.log.debug(`Cannot watch the fullcalendar instances: ${e.message}`);
        }
    }

    /**
     * Restart an instance the way the restart button of admin does (the instance object is written, js-controller
     * restarts it) and wait until it runs again. The guard in lib/tools.js has checked the permission and the
     * confirmation of the user.
     *
     * @param {string} instance e.g. "telegram.0"
     * @returns {Promise<string>} what happened, for the model
     */
    async restartInstance(instance) {
        const id = `system.adapter.${instance}`;
        const obj = await this.getForeignObjectAsync(id);
        if (!obj || obj.type !== 'instance') {
            throw new Error(`There is no instance ${instance}`);
        }
        if (!obj.common?.enabled) {
            return `${instance} is switched off; the agent does not switch instances on. Tell the user.`;
        }
        const started = Date.now();
        await this.extendForeignObjectAsync(id, { common: { enabled: true } });
        if (obj.common.mode !== 'daemon') {
            return `${instance} was restarted (mode "${obj.common.mode}": it runs on its schedule and is not alive between runs).`;
        }
        // running again: alive, with an uptime that began after the restart
        while (Date.now() - started < this.restartWaitMs && !this.stopping) {
            await new Promise(resolve => this.setTimeout(resolve, 1000));
            const [alive, uptime] = await Promise.all([
                this.getForeignStateAsync(`${id}.alive`),
                this.getForeignStateAsync(`${id}.uptime`),
            ]);
            const seconds = (Date.now() - started) / 1000;
            if (alive?.val === true && uptime && Number(uptime.val) <= seconds + 1) {
                return `${instance} was restarted and runs again (after ${Math.round(seconds)} s).`;
            }
        }
        return `The restart of ${instance} was sent, but it did not report running again within ${Math.round(this.restartWaitMs / 1000)} s. Tell the user to look at the log of ${instance}.`;
    }

    /**
     * The reminders and scheduled writes of a conversation that are not done yet: the live tasks of the harness.
     *
     * @param {unknown} conversationId conversation
     * @returns {Promise<Array<{ id: string, taskId: import("@earendil-works/pi-durable").TaskId, kind: string, at: number, text?: string, state?: string, value?: unknown }>>} planned tasks
     */
    async plannedTasks(conversationId) {
        const inspection = await this.harness.inspect(this.context);
        return inspection.tasks
            .map(t => t.record)
            .filter(
                r =>
                    ['iobroker.reminder', 'iobroker.write'].includes(String(r.kind)) &&
                    String(Object(r.input).conversationId) === String(conversationId),
            )
            .map(r => {
                const input = Object(r.input);
                return r.kind === 'iobroker.reminder'
                    ? {
                          id: `t${r.id}`,
                          taskId: r.id,
                          kind: 'reminder',
                          at: Number(input.at),
                          text: String(input.text ?? ''),
                      }
                    : {
                          id: `t${r.id}`,
                          taskId: r.id,
                          kind: 'scheduled write',
                          at: Number(input.at),
                          state: String(input.id),
                          value: input.val,
                      };
            })
            .sort((a, b) => a.at - b.at);
    }

    /**
     * Cancel a reminder or a scheduled write of a conversation.
     *
     * @param {unknown} conversationId conversation
     * @param {string} id id from list_scheduled, e.g. "t123"
     * @returns {Promise<boolean>} true when it was planned in this conversation
     */
    async cancelPlanned(conversationId, id) {
        const planned = (await this.plannedTasks(conversationId)).find(p => p.id === id);
        if (!planned) {
            return false;
        }
        await this.harness.abortTask(planned.taskId, this.context);
        return true;
    }

    /** Publish the token use and cost of all conversations in usage.*. */
    async updateUsage() {
        try {
            const state = await this.harness.usage(this.context);
            const all = [...Object.values(state.models || {}), ...Object.values(state.tools || {})];
            const sum = pick => all.reduce((total, usage) => total + (Number(pick(usage)) || 0), 0);
            await this.setStateAsync('usage.tokensInput', { val: sum(u => u.input), ack: true });
            await this.setStateAsync('usage.tokensOutput', { val: sum(u => u.output), ack: true });
            await this.setStateAsync('usage.tokensTotal', { val: sum(u => u.totalTokens), ack: true });
            await this.setStateAsync('usage.cost', { val: Math.round(sum(u => u.cost?.total) * 1e6) / 1e6, ack: true });
            await this.setStateAsync('usage.json', { val: JSON.stringify(state), ack: true });
        } catch (e) {
            this.log.warn(`Usage could not be published: ${e.message}`);
        }
    }

    /** Write the pending list; writes are chained so the newest list always wins. */
    savePending() {
        this.pendingWrite = this.pendingWrite
            .then(async () => {
                await this.setStateAsync('chat.pending', {
                    val: this.pending.length ? JSON.stringify(this.pending) : '',
                    ack: true,
                });
            })
            .catch(e => {
                this.log.warn(`Pending requests could not be saved: ${e.message}`);
            });
        return this.pendingWrite;
    }

    /**
     * Submit a request exactly once and return the answer text.
     *
     * @param {string} content user text
     * @param {string} requestId stable id, so a retry finds the original submission
     * @param {{ kind: string, instance?: string, chatId?: string }} [target] where the answer goes (kept for a restart)
     * @returns {Promise<string>} answer text
     */
    ask(content, requestId, target = { kind: 'state' }) {
        // Recorded before the request waits in the queue, so a queued request also survives a restart.
        const admitted = (async () => {
            await this.readyPromise;
            if (!this.root) {
                throw new Error('Agent is not running');
            }
            this.pending = this.pending.filter(p => p.requestId !== requestId).concat({ requestId, content, target });
            await this.savePending();
        })();
        // One queue per conversation: a chat waits for its own earlier request, not for other chats.
        const key = this.chatKeyOf(target) || 'root';
        const previous = this.queues.get(key) || Promise.resolve();
        const run = Promise.all([admitted, previous]).then(async () => {
            try {
                const conversation = await this.conversationFor(target);
                const submission = await conversation.submit({ type: 'input', content, requestId }, this.context);
                const settled = await submission.wait(this.context);
                if (settled.status !== 'done') {
                    throw new Error(`Request not answered (${settled.reason ?? settled.status})`);
                }
                const answer = await this.lastAnswer(conversation);
                await this.removePending(requestId);
                void this.updateUsage();
                return answer;
            } catch (e) {
                if (!this.stopping) {
                    await this.removePending(requestId);
                }
                throw e;
            }
        });
        const tail = run.catch(() => undefined);
        this.queues.set(key, tail);
        // forget a finished queue so idle chats do not accumulate
        void tail.then(() => this.queues.get(key) === tail && this.queues.delete(key));
        admitted.catch(() => undefined);
        return run;
    }

    /** @param {string} requestId request to drop from the pending list */
    async removePending(requestId) {
        this.pending = this.pending.filter(p => p.requestId !== requestId);
        await this.savePending();
    }

    /**
     * Text of the newest assistant message of a conversation.
     *
     * @param {object} conversation conversation handle
     * @returns {Promise<string>} answer text
     */
    async lastAnswer(conversation) {
        const view = await conversation.viewState(this.context);
        try {
            const entries = view.value.entries;
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].kind !== 'pi.assistant') {
                    continue;
                }
                const answer = answerText(entries[i].model || []);
                if (answer) {
                    return answer;
                }
            }
            return '';
        } finally {
            view.dispose?.();
        }
    }

    /**
     * Run a request and deliver the answer (or the error) to its target.
     *
     * @param {{ requestId: string, content: string, target: { kind: string, instance?: string, chatId?: string } }} entry request
     */
    async process(entry) {
        try {
            const answer = await this.ask(entry.content, entry.requestId, entry.target);
            await this.deliver(entry.target, answer);
        } catch (e) {
            if (this.stopping) {
                // The request stays pending, so the next start continues it.
                this.log.info('Request interrupted by shutdown; it continues after the next start');
                return;
            }
            this.log.error(`Request failed: ${e.message}`);
            if (entry.target.kind === 'admin') {
                this.adminChat.setError(String(entry.target.chatId), e.message);
                return;
            }
            await this.deliver(entry.target, `Error: ${e.message}`);
        }
    }

    /**
     * @param {{ kind: string, instance?: string, chatId?: string }} target where the answer goes
     * @param {string} text answer or error text
     */
    async deliver(target, text) {
        if (target.kind === 'admin') {
            return; // the admin tab reads the answer from the conversation
        }
        if (target.kind === 'chat') {
            this.channels.get(target.instance).driver.send(target.instance, target.chatId, text);
            return;
        }
        // "state", and "sendTo" after a restart: the caller is no longer waiting.
        await this.setStateAsync('chat.answer', { val: text, ack: true });
    }

    async resumePending() {
        const stored = await this.getStateAsync('chat.pending');
        let entries;
        try {
            entries = parsePending(stored?.val);
        } catch (e) {
            this.log.warn(`Pending requests could not be read and are dropped: ${e.message}`);
            await this.setStateAsync('chat.pending', { val: '', ack: true });
            return;
        }
        this.pending = entries;
        for (const entry of entries) {
            if (entry.target.kind === 'chat') {
                // entries of 0.0.5 and earlier have no instance: they came from the only one
                entry.target = { ...entry.target, instance: entry.target.instance || this.firstChannel() };
                if (!this.channels.has(entry.target.instance)) {
                    entry.target = { kind: 'state' }; // this messenger instance was switched off meanwhile
                }
            }
            this.log.info(`Continuing request ${entry.requestId} after restart`);
        }
        await Promise.all(entries.map(entry => this.process(entry)));
    }

    /**
     * @param {string} id state id
     * @param {ioBroker.State | null | undefined} state new state
     */
    async onStateChange(id, state) {
        const instance = id.endsWith('.communicate.request') ? id.slice(0, -'.communicate.request'.length) : '';
        if (this.channels.has(instance)) {
            return this.onChatMessage(instance, state);
        }
        if (this.watches.handles(id)) {
            await this.watches.onState(id, state);
        }
        if (id === `${this.namespace}.memory.list` && state && !state.ack) {
            // the user edited the facts: take them over (invalid entries are dropped) and confirm with ack
            await this.memory.replace(state.val);
            this.log.info(`Long-term memory edited: ${this.memory.list().length} fact(s)`);
            return;
        }
        if (!state || state.ack || id !== `${this.namespace}.chat.input` || !state.val) {
            return;
        }
        const requestId = requestIdFor(crypto, state.ts, state.val);
        await this.process({ requestId, content: String(state.val), target: { kind: 'state' } });
        if (!this.stopping) {
            await this.setStateAsync('chat.input', { val: String(state.val), ack: true });
        }
    }

    /**
     * A message arrived at a messenger instance: check sender and prefix, then ask in the chat's conversation.
     *
     * @param {string} instance messenger instance the message came from
     * @param {ioBroker.State | null | undefined} state value of <instance>.communicate.request ("[name]text")
     */
    async onChatMessage(instance, state) {
        if (!state || !state.val) {
            return;
        }
        const { allowed, prefix, driver } = this.channels.get(instance);
        const request = await driver.readRequest(instance, state.val);
        const { chatId, messageId, name, text, sender } = request;
        if (!chatId) {
            this.log.warn(`${driver.label} message on ${instance} without chat id ignored`);
            return;
        }
        if (!isAllowedUser(sender, allowed)) {
            const who = [sender.firstName, sender.userName].filter(Boolean).join(' / ') || name || '?';
            this.log.warn(
                `${driver.label} message on ${instance} from ${who} (${sender.userId ?? '?'}) ignored: user not allowed`,
            );
            return;
        }
        if (driver.takeButton(instance, request)) {
            return; // a button of a confirmation, not a message for the model
        }
        const content = stripPrefix(text, prefix);
        if (content === null) {
            return; // not for the agent; the bot may serve other scripts too
        }
        const requestId =
            messageId !== null && messageId !== undefined
                ? telegramRequestId(instance, chatId, messageId)
                : requestIdFor(crypto, state.ts, state.val);
        await this.process({ requestId, content, target: { kind: 'chat', instance, chatId } });
    }

    /**
     * Commands of the chat in the admin tab (admin/tab.html). The page polls chatHistory while a request runs.
     *
     * @param {string} command chatHistory, chatSend, chatConfirm, chatNew or chatConversations
     * @param {string} user ioBroker user of the admin session
     * @param {{ text?: unknown, nonce?: unknown, answer?: unknown, conversation?: unknown }} message message of the page
     * @returns {Promise<object>} answer for the page
     */
    async onAdminChat(command, user, message) {
        const key = chatKey(ADMIN, user);
        const busy = () =>
            this.adminRunning.has(user) ||
            this.pending.some(p => p.target.kind === 'admin' && p.target.chatId === user);
        if (command === 'chatSend') {
            const text = String(message.text || '').trim();
            if (!this.root) {
                return { error: 'notRunning' };
            }
            if (!text || busy()) {
                return { error: text ? 'busy' : 'empty' };
            }
            this.adminChat.setError(user, null);
            this.adminRunning.add(user);
            const requestId = `admin-${crypto.randomBytes(8).toString('hex')}`;
            void this.process({ requestId, content: text, target: { kind: 'admin', chatId: user } }).finally(() =>
                this.adminRunning.delete(user),
            );
            return { accepted: true };
        }
        if (command === 'chatConfirm') {
            return { ok: this.adminChat.answer(user, message.nonce, message.answer) };
        }
        if (command === 'chatNew') {
            if (busy()) {
                return { error: 'busy' };
            }
            // the old conversation is deleted from the store at the next start (lib/purge.js)
            queuePurge(utils.getAbsoluteInstanceDataDir(this), this.chats[key]);
            delete this.chats[key];
            await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
            this.adminChat.clear(user);
            this.log.info(`Admin chat of ${user}: new conversation`);
            return { ok: true };
        }
        const isAdmin = await this.isAdministrator(user);
        if (command === 'chatConversations') {
            return { conversations: this.conversationList(user, isAdmin) };
        }
        // chatHistory: the user's own conversation, or (administrators only, read only) any other one
        const status = {
            running: Boolean(this.root),
            model: this.model ? `${this.model.provider}/${this.model.modelId}` : '',
            simulation: Boolean(this.config.dryRun),
            user,
            administrator: isAdmin,
        };
        const other = String(message.conversation || '');
        if (other && other !== key) {
            if (!isAdmin || !this.chats[other]) {
                return { error: isAdmin ? 'unknownConversation' : 'forbidden' };
            }
            return {
                ...status,
                conversation: other,
                readOnly: true,
                busy: this.queues.has(other),
                question: null,
                error: null,
                entries: await this.historyOfKey(other),
            };
        }
        return {
            ...status,
            conversation: key,
            readOnly: false,
            busy: busy(),
            question: this.adminChat.question(user),
            error: this.adminChat.error(user),
            entries: withNotices(await this.historyOfKey(key), this.adminChat.notices(user)),
        };
    }

    /**
     * The messages of a conversation of telegram.chats as the admin page shows them.
     *
     * @param {string} key key in telegram.chats
     * @returns {Promise<Array<object>>} messages, oldest first; empty when the conversation does not exist
     */
    async historyOfKey(key) {
        const conversation = this.chats[key] ? await this.harness?.conversation(this.chats[key], this.context) : null;
        if (!conversation) {
            return [];
        }
        const view = await conversation.viewState(this.context);
        try {
            return historyOf(view.value.entries);
        } finally {
            view.dispose?.();
        }
    }

    /**
     * Whether an ioBroker user is in the group "administrator" (only they may read the conversations of others).
     *
     * @param {string} user e.g. "system.user.admin"
     * @returns {Promise<boolean>} true for an administrator
     */
    async isAdministrator(user) {
        if (user === 'system.user.admin') {
            return true;
        }
        try {
            const group = await this.getForeignObjectAsync('system.group.administrator');
            const members = Object(group?.common).members;
            return Array.isArray(members) && members.includes(user);
        } catch {
            return false;
        }
    }

    /**
     * The conversations the admin page offers: the user's own chat first, for an administrator also the chats of the
     * messengers, of the other admin users and of sendTo callers such as ioBroker.assistant.
     *
     * @param {string} user ioBroker user of the page
     * @param {boolean} isAdmin whether the user may read the others
     * @returns {Array<{ key: string, kind: string, source: string, name: string, own: boolean }>} conversations
     */
    conversationList(user, isAdmin) {
        const own = chatKey(ADMIN, user);
        const list = [{ key: own, kind: 'admin', source: ADMIN, name: user.replace(/^system\.user\./, ''), own: true }];
        if (!isAdmin) {
            return list;
        }
        const others = Object.keys(this.chats)
            .filter(key => key !== own)
            .map(key => {
                const { instance, chatId } = parseChatKey(key, this.firstChannel());
                const sendTo = instance.startsWith('sendTo:');
                return {
                    key,
                    kind: instance === ADMIN ? 'admin' : sendTo ? 'sendTo' : 'chat',
                    source: sendTo ? instance.slice('sendTo:'.length) : instance,
                    name: instance === ADMIN ? chatId.replace(/^system\.user\./, '') : chatId,
                    own: false,
                };
            })
            .sort(
                (a, b) =>
                    a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
            );
        return [...list, ...others];
    }

    /**
     * Provider settings sent by the admin page (unsaved form values); missing fields come from the saved configuration.
     * With the system-wide AI settings (see usesSystemAi) they come from system.ai, as the agent would use them.
     *
     * @param {unknown} message jsonData of the admin page
     * @returns {Promise<{ provider: string, modelId: string, baseUrl: string, keySource: string, apiKey: string, credentialId: string }>} settings
     */
    async providerForm(message) {
        const form = Object(message);
        const pick = name => String(form[name] ?? this.config[name] ?? '').trim();
        const own = {
            provider: pick('provider'),
            modelId: pick('modelId'),
            baseUrl: pick('baseUrl'),
            keySource: pick('keySource'),
            apiKey: pick('apiKey'),
            credentialId: pick('credentialId'),
        };
        if (!usesSystemAi(own)) {
            return own;
        }
        const system = systemAiForm((await readSystemAi(this))?.native);
        if (system) {
            return system;
        }
        if (keySourceOf(own) === 'system') {
            throw new Error('The system-wide AI settings have no provider (admin: System settings, tab "AI")');
        }
        return own;
    }

    /**
     * Ask the configured model one short question.
     *
     * @param {Awaited<ReturnType<PiAgent['providerForm']>>} form provider settings
     * @returns {Promise<string>} text for the admin page
     */
    async testConnection(form) {
        const key = await resolveApiKey(this, form);
        if (!key && form.provider !== 'custom') {
            throw new Error(form.keySource === 'central' ? 'No credential chosen' : 'No API key entered');
        }
        if (form.provider === 'custom' && !form.modelId) {
            throw new Error('No model entered');
        }
        const { spec, models } = await createModelsWithKey(form.provider, key, {
            baseUrl: form.baseUrl,
            modelId: form.modelId,
        });
        const modelId = form.modelId || spec.defaultModel;
        const reply = await testModel(models, form.provider, modelId);
        return `${form.provider}/${modelId}: ${reply.slice(0, 200)}`;
    }

    /** @param {ioBroker.Message} obj message from a script or another adapter */
    async onMessage(obj) {
        // output and end of a command on the host (an update of an adapter)
        if (this.hostCommands.onMessage(obj)) {
            return;
        }
        if (obj?.command === 'listModels') {
            // model field of the admin page; needs no running agent, and an API key only for a custom server
            let options = [];
            try {
                const form = await this.providerForm(obj.message);
                options = await listModels(form.provider, {
                    baseUrl: form.baseUrl,
                    apiKey: form.provider === 'custom' ? await resolveApiKey(this, form) : '',
                });
            } catch (e) {
                this.log.debug(`No model list: ${e.message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (obj?.command === 'testConnection') {
            // button of the admin page: one short question with the unsaved values of the form
            let answer;
            try {
                answer = { result: await this.testConnection(await this.providerForm(obj.message)) };
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (obj?.command === 'importInstances') {
            // button of the admin page: jsonData sends the unsaved table, "native" in the answer (useNative) replaces it
            let answer;
            try {
                const { rows, added } = await this.writeRulesWithInstances(Object(obj.message).writeRules);
                answer = { native: { writeRules: rows } };
                this.log.info(`Write permissions: ${added} installed instance(s) added to the table (not saved yet)`);
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (['chatHistory', 'chatSend', 'chatConfirm', 'chatNew', 'chatConversations'].includes(String(obj?.command))) {
            let answer;
            try {
                answer = await this.onAdminChat(obj.command, adminUser(obj), Object(obj.message));
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (BACKUP_COMMANDS.includes(String(obj?.command))) {
            // tab "Backup" of the admin page
            let answer;
            try {
                answer = await this.onBackupCommand(String(obj.command), Object(obj.message));
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (obj?.command === 'listTimeZones') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, timeZoneOptions(), obj.callback);
            }
            return;
        }
        if (obj?.command === 'listMessengerInstances') {
            let options = [];
            try {
                options = await this.messengerInstanceOptions();
            } catch (e) {
                this.log.debug(`No list of messenger instances: ${e.message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (!obj || obj.command !== 'ask') {
            return;
        }
        let result;
        try {
            const message = typeof obj.message === 'string' ? { text: obj.message } : obj.message || {};
            if (!message.text) {
                throw new Error('Missing "text"');
            }
            const requestId = message.requestId || requestIdFor(crypto, Date.now(), message.text);
            const target = sendToTarget(obj.from, message);
            result = { answer: await this.ask(String(message.text), String(requestId), target) };
        } catch (e) {
            result = {
                error: this.stopping
                    ? 'Interrupted by shutdown; the request continues after the next start'
                    : e.message,
            };
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }

    /** @param {() => void} callback called when everything is stopped */
    onUnload(callback) {
        this.stopping = true;
        this.clearTimeout(this.backupTimer);
        this.watches.stop();
        const done = async () => {
            try {
                await this.harness?.close(this.context);
            } catch (e) {
                this.log.error(`Closing the harness failed: ${e.message}`);
            }
            try {
                await this.pendingWrite;
                await this.setStateAsync('info.connection', { val: false, ack: true });
            } finally {
                callback();
            }
        };
        void done();
    }
}

if (require.main !== module) {
    module.exports = options => new PiAgent(options);
} else {
    new PiAgent();
}
