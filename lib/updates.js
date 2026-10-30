'use strict';

/**
 * Updates of adapters for the tools list_updates, check_npm and update_adapter.
 *
 * - The available versions come from the repositories that ioBroker has already downloaded (object
 *   system.repositories, the active ones in system.config common.activeRepo), as admin shows them: no network.
 * - An update runs on the host of pi-agent with the host command cmdExec, the same way the update button of admin
 *   does: "upgrade <adapter>@<version>" from the repository, "url iobroker.<adapter>@<version>" from npm. The host
 *   reports the output (cmdStdout, cmdStderr) and the exit code (cmdExit) as messages to this instance.
 */

/** Adapters the agent never updates: admin (the user would lose the page) and js-controller (needs a stop of ioBroker). */
const NEVER_UPDATE = ['admin', 'js-controller'];

/** How long an update may take before the agent stops waiting (it goes on on the host). */
const UPDATE_TIMEOUT_MS = 10 * 60_000;

/** At most this many lines of the output of an update go back to the model. */
const OUTPUT_LINES = 15;

/** A version as npm and ioBroker write it, e.g. "1.2.3" or "1.2.3-alpha.1". */
const VERSION = /^\d+\.\d+\.\d+[\w.+-]*$/;

/**
 * Compare two versions: numbers part by part; a pre-release ("-alpha.1") is older than the release.
 *
 * @param {string} a version
 * @param {string} b version
 * @returns {number} > 0 when a is newer, < 0 when b is newer, 0 when equal
 */
function compareVersions(a, b) {
    const parse = v => {
        const [main, pre = ''] = String(v || '0').split('-', 2);
        return { parts: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
        const d = (x.parts[i] || 0) - (y.parts[i] || 0);
        if (d) {
            return d;
        }
    }
    if (x.pre === y.pre) {
        return 0;
    }
    if (!x.pre || !y.pre) {
        return x.pre ? -1 : 1;
    }
    return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/**
 * Name of an adapter as the model may write it: "telegram", also "iobroker.telegram", "telegram.0" or
 * "system.adapter.telegram".
 *
 * @param {unknown} value argument of the model
 * @returns {string} adapter name, lower case
 */
function adapterNameOf(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^system\.adapter\./, '')
        .replace(/^iobroker\./, '')
        .replace(/\.\d+$/, '');
}

/**
 * The JSON of the active repositories (all of them when none is marked active); an adapter in several repositories
 * is taken from the first one.
 *
 * @param {Pick<ioBroker.Adapter, 'getForeignObjectAsync'>} adapter adapter instance
 * @returns {Promise<{ names: string[], json: Record<string, unknown> }>} repository names and adapters by name
 */
async function repositoryJson(adapter) {
    const reposObj = await adapter.getForeignObjectAsync('system.repositories');
    const repositories = Object(reposObj?.native?.repositories);
    const config = await adapter.getForeignObjectAsync('system.config');
    const active = config?.common?.activeRepo;
    const activeNames = (Array.isArray(active) ? active : active ? [active] : []).filter(n => repositories[n]?.json);
    const names = activeNames.length ? activeNames : Object.keys(repositories).filter(n => repositories[n]?.json);
    const json = new Map();
    for (const name of names) {
        for (const [key, value] of Object.entries(Object(repositories[name].json))) {
            if (!key.startsWith('_') && !json.has(key)) {
                json.set(key, value);
            }
        }
    }
    return { names, json: Object.fromEntries(json) };
}

/**
 * The installed adapters with their version, and the hosts of their instances.
 *
 * @param {Pick<ioBroker.Adapter, 'getObjectViewAsync'>} adapter adapter instance
 * @returns {Promise<Array<{ name: string, version: string, title: string, instances: string[], hosts: string[] }>>} adapters
 */
async function installedAdapters(adapter) {
    const range = { startkey: 'system.adapter.', endkey: 'system.adapter.香' };
    const adapters = await adapter.getObjectViewAsync('system', 'adapter', range);
    const instances = await adapter.getObjectViewAsync('system', 'instance', range);
    return (adapters?.rows || [])
        .filter(row => row.value?.common)
        .map(row => {
            const common = row.value.common;
            const name = String(common.name || row.id.slice('system.adapter.'.length));
            const own = (instances?.rows || []).filter(r => r.id.startsWith(`system.adapter.${name}.`));
            const title = common.titleLang && typeof common.titleLang === 'object' ? common.titleLang.en : common.title;
            return {
                name,
                version: String(common.version || common.installedVersion || ''),
                title: String(title || name),
                instances: own.map(r => r.id.slice('system.adapter.'.length)),
                hosts: [...new Set(own.map(r => String(r.value?.common?.host || '')).filter(Boolean))],
            };
        });
}

/**
 * Whether the agent may update an adapter: the option is on, it is not admin or js-controller, and one of its
 * instances is allowed for writing — or it is pi-agent itself, whose own instance is never in the table.
 *
 * @param {string} name adapter name
 * @param {{ instances: string[] }} installed the installed adapter
 * @param {{ enabled: boolean, own: string, isAllowed: (instance: string) => boolean }} rules option, own adapter
 *     name, and the write permission of an instance
 * @returns {string} "" when allowed, else the reason
 */
function updateRefusal(name, installed, rules) {
    if (!rules.enabled) {
        return 'adapter updates are switched off in the pi-agent settings (tab "Write permissions", "Allow adapter updates")';
    }
    if (NEVER_UPDATE.includes(name)) {
        return `${name} is never updated by the agent; update it in admin`;
    }
    if (name === rules.own || installed.instances.some(i => rules.isAllowed(i))) {
        return '';
    }
    return `no instance of ${name} has "Write allowed" in the write permissions of pi-agent`;
}

/**
 * The newest version of an adapter on npm (dist-tag "latest").
 *
 * @param {string} name adapter name
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<string>} version
 */
async function npmLatest(name, fetchImpl = fetch) {
    const response = await fetchImpl(`https://registry.npmjs.org/iobroker.${encodeURIComponent(name)}/latest`, {
        signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
        throw new Error(`iobroker.${name} is not on npm`);
    }
    if (!response.ok) {
        throw new Error(`npm answered ${response.status} for iobroker.${name}`);
    }
    const version = String(Object(await response.json()).version || '');
    if (!VERSION.test(version)) {
        throw new Error(`npm gave no version for iobroker.${name}`);
    }
    return version;
}

/**
 * Commands on the host and their output: start one, collect cmdStdout/cmdStderr and wait for cmdExit.
 *
 * @param {object} adapter adapter instance (sendToHost, timers, log)
 * @returns {{ run: (host: string, command: string, timeoutMs?: number) => Promise<{ finished: boolean, exitCode: number | null, output: string[] }>, onMessage: (msg: ioBroker.Message) => boolean }} runner
 */
function createHostCommands(adapter) {
    /** session id -> output and the end of the wait */
    const sessions = new Map();
    let counter = 0;
    return {
        run(host, command, timeoutMs = UPDATE_TIMEOUT_MS) {
            const id = `pi-agent-${Date.now().toString(36)}-${++counter}`;
            const output = [];
            adapter.log.info(`Host command on ${host}: iobroker ${command}`);
            return new Promise(resolve => {
                const timer = adapter.setTimeout(() => {
                    sessions.delete(id);
                    resolve({ finished: false, exitCode: null, output });
                }, timeoutMs);
                sessions.set(id, {
                    output,
                    end: code => {
                        adapter.clearTimeout(timer);
                        resolve({ finished: true, exitCode: code, output });
                    },
                });
                adapter.sendToHost(`system.host.${host}`, 'cmdExec', { data: command, id });
            });
        },

        /**
         * A message of the host about a command of this instance.
         *
         * @param {ioBroker.Message} msg message
         * @returns {boolean} true when it was one (nothing else to do with it)
         */
        onMessage(msg) {
            if (!['cmdStdout', 'cmdStderr', 'cmdExit'].includes(String(msg?.command))) {
                return false;
            }
            const session = sessions.get(Object(msg.message).id);
            if (!session) {
                return true; // of another instance or repeated
            }
            if (msg.command === 'cmdExit') {
                sessions.delete(Object(msg.message).id);
                session.end(typeof msg.message.data === 'number' ? msg.message.data : -1);
            } else {
                session.output.push(String(Object(msg.message).data ?? '').trimEnd());
                if (session.output.length > 200) {
                    session.output.splice(0, session.output.length - 200);
                }
            }
            return true;
        },
    };
}

module.exports = {
    NEVER_UPDATE,
    OUTPUT_LINES,
    VERSION,
    compareVersions,
    adapterNameOf,
    repositoryJson,
    installedAdapters,
    updateRefusal,
    npmLatest,
    createHostCommands,
};
