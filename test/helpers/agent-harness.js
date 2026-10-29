'use strict';

// Runs the real main.js against a stand-in for @iobroker/adapter-core and the faux model of pi-ai.
// States, objects and foreign writes live in <dataDir>/fake-db.json, so they survive a killed process.

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const NAMESPACE = 'pi-agent.0';

class FakeDb {
    constructor(dataDir, seed = {}) {
        this.file = path.join(dataDir, 'fake-db.json');
        if (fs.existsSync(this.file)) {
            Object.assign(this, JSON.parse(fs.readFileSync(this.file, 'utf8')));
        } else {
            this.states = seed.states || {};
            this.objects = seed.objects || {};
            this.writes = [];
            this.save();
        }
    }

    save() {
        const { states, objects, writes } = this;
        fs.writeFileSync(this.file, JSON.stringify({ states, objects, writes }));
    }

    setState(id, state) {
        this.states[id] = { ...state, ts: state.ts ?? Date.now() };
        this.save();
    }
}

/**
 * Create the stand-in module for @iobroker/adapter-core.
 *
 * @param {object} hooks optional async hooks: getForeignState(id), setForeignState(id, state)
 * @returns {object} module exports
 */
function fakeAdapterCore(hooks) {
    class Adapter extends EventEmitter {
        constructor(options) {
            super();
            this.name = options.name;
            this.namespace = NAMESPACE;
            this.config = options.config;
            this.dataDir = options.dataDir;
            this.db = options.db;
            this.logs = [];
            this.sent = [];
            this.log = Object.fromEntries(
                ['debug', 'info', 'warn', 'error'].map(level => [level, msg => this.logs.push([level, msg])]),
            );
        }
        async setStateAsync(id, state) {
            this.db.setState(`${NAMESPACE}.${id}`, state);
        }
        async getStateAsync(id) {
            return this.db.states[`${NAMESPACE}.${id}`] ?? null;
        }
        // Like js-controller: merges type/common/native into an existing object and keeps its ACL.
        async extendObjectAsync(id, obj) {
            const full = `${NAMESPACE}.${id}`;
            const old = this.db.objects[full];
            this.db.objects[full] = old
                ? { ...old, ...obj, common: { ...old.common, ...obj.common }, acl: old.acl }
                : { ...obj, acl: { owner: 'system.user.admin', ownerGroup: 'system.group.administrator' } };
            this.db.save();
        }
        async subscribeStatesAsync() {}
        async subscribeForeignStatesAsync(pattern) {
            this.foreignSubscriptions = [...(this.foreignSubscriptions || []), pattern];
        }
        async unsubscribeForeignStatesAsync(pattern) {
            this.foreignSubscriptions = (this.foreignSubscriptions || []).filter(p => p !== pattern);
        }
        async getForeignStateAsync(id) {
            await hooks.getForeignState?.(id);
            return this.db.states[id] ?? null;
        }
        async getForeignStatesAsync(ids) {
            return Object.fromEntries(ids.filter(id => this.db.states[id]).map(id => [id, this.db.states[id]]));
        }
        async getForeignObjectAsync(id) {
            const obj = this.db.objects[id];
            return obj ? JSON.parse(JSON.stringify(obj)) : null;
        }
        async setForeignObjectAsync(id, obj) {
            this.db.objects[id] = JSON.parse(JSON.stringify(obj));
            this.db.save();
        }
        async extendForeignObjectAsync(id, obj) {
            const old = this.db.objects[id] || {};
            this.db.objects[id] = {
                ...old,
                ...obj,
                common: { ...old.common, ...obj.common },
                native: { ...old.native, ...obj.native },
            };
            this.db.save();
        }
        async getObjectViewAsync(design, search, params) {
            const type = search; // the views of js-controller are named like the object types (state, instance, enum)
            const rows = Object.keys(this.db.objects)
                .sort()
                .filter(id => this.db.objects[id].type === type && id >= params.startkey && id <= params.endkey)
                .map(id => ({ id, value: this.db.objects[id] }));
            return { rows };
        }
        async setForeignStateAsync(id, state) {
            this.db.writes.push([id, state.val]);
            this.db.setState(id, state);
            await hooks.setForeignState?.(id, state);
        }
        // Credentials of the central store: the test seed holds them "encrypted" as "enc:<value>".
        decrypt(value) {
            return String(value).replace(/^enc:/, '');
        }
        async subscribeForeignObjectsAsync(pattern) {
            this.objectSubscriptions = [...(this.objectSubscriptions || []), pattern];
        }
        async setForeignObjectNotExistsAsync(id, obj) {
            if (!this.db.objects[id]) {
                await this.setForeignObjectAsync(id, obj);
            }
        }
        // File storage: kept in memory, keyed "<meta id>/<path>".
        async writeFileAsync(metaId, file, data) {
            if (!this.db.objects[metaId]) {
                throw new Error(`${metaId} is not a meta object`);
            }
            this.files = { ...this.files, [`${metaId}/${file}`]: Buffer.from(data) };
        }
        async readFileAsync(metaId, file) {
            const data = this.files?.[`${metaId}/${file}`];
            if (!data) {
                throw new Error('Not exists');
            }
            return { file: data, mimeType: 'application/octet-stream' };
        }
        async readDirAsync(metaId, dir) {
            const prefix = `${metaId}/${dir}/`;
            const names = Object.keys(this.files || {}).filter(key => key.startsWith(prefix));
            if (names.length === 0) {
                throw new Error('Not exists');
            }
            return names.map(key => ({
                file: key.slice(prefix.length),
                isDir: false,
                stats: { size: this.files[key].length },
            }));
        }
        async delFileAsync(metaId, file) {
            delete this.files[`${metaId}/${file}`];
        }
        // Timers of the adapter; js-controller clears them when the instance stops, here they do not keep the test alive.
        setTimeout(callback, ms) {
            const handle = globalThis.setTimeout(callback, ms);
            handle.unref?.();
            return handle;
        }
        clearTimeout(handle) {
            globalThis.clearTimeout(handle);
        }
        restart() {
            this.restarted = (this.restarted || 0) + 1;
        }
        sendTo(...args) {
            this.sent.push(args);
        }
        // Messages that wait for an answer (telegram "ask", history "getHistory") go through the hook.
        async sendToAsync(instance, command, message) {
            this.asked = [...(this.asked || []), [instance, command, message]];
            return hooks.sendToAsync ? hooks.sendToAsync(instance, command, message) : undefined;
        }
    }
    return {
        Adapter,
        getAbsoluteInstanceDataDir: adapter => adapter.dataDir,
        // iobroker-data; the log folder is next to it (tests of get_logs set it)
        getAbsoluteDefaultDataDir: () => process.env.PI_AGENT_TEST_DATA_DIR || path.join(require('node:os').tmpdir(), 'no-iobroker-data'),
    };
}

/**
 * Start one agent instance on a data directory.
 *
 * @param {object} options
 * @param {string} options.dataDir directory for the conversation store and the fake database
 * @param {object} [options.config] native configuration (apiKey, writeAllow, dryRun, ...)
 * @param {object} [options.seed] initial { states, objects } of the fake database
 * @param {Array} options.responses faux responses (messages or factories) for this instance
 * @param {object} [options.hooks] hooks of the fake adapter
 * @returns {Promise<{ agent: object, adapter: object, db: FakeDb, faux: object, providerCalls: Array }>} running
 *   instance; providerCalls are the arguments of each createModelsWithKey (provider, key, options)
 */
async function startAgent({ dataDir, config = {}, seed, responses, hooks = {} }) {
    const fauxModule = await import('@earendil-works/pi-ai/providers/faux');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const faux = fauxModule.fauxProvider({ provider: 'faux' });
    faux.setResponses(responses);

    const mainPath = require.resolve('../../main.js');
    const providersPath = require.resolve('../../lib/providers.js');
    const corePath = require.resolve('@iobroker/adapter-core');
    const realProviders = require(providersPath);
    const providerCalls = [];
    delete require.cache[mainPath];
    require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: fakeAdapterCore(hooks) };
    require.cache[providersPath] = {
        id: providersPath,
        filename: providersPath,
        loaded: true,
        exports: {
            ...realProviders,
            createModelsWithKey: async (...args) => {
                providerCalls.push(args);
                const models = createModels();
                models.setProvider(faux.provider);
                return { spec: { defaultModel: faux.getModel().id }, models };
            },
        },
    };
    try {
        const createAgent = require(mainPath);
        const db = new FakeDb(dataDir, seed);
        const agent = createAgent({
            dataDir,
            db,
            config: { provider: 'faux', modelId: '', apiKey: 'test', writeAllow: '', dryRun: true, ...config },
        });
        agent.emit('ready');
        await agent.readyPromise;
        return { agent, adapter: agent, db, faux, providerCalls };
    } finally {
        delete require.cache[providersPath];
        delete require.cache[corePath];
    }
}

/** Stop an instance the way js-controller does and wait for the unload callback. */
function stopAgent(agent) {
    return new Promise(resolve => agent.emit('unload', resolve));
}

/** Wait until a condition holds (polling, for asynchronous effects of the agent). */
async function waitFor(condition, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await condition()) {
            return;
        }
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

module.exports = { startAgent, stopAgent, waitFor, NAMESPACE };
