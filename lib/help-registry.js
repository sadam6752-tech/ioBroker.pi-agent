'use strict';

const { readHelp, mayDescribeItself, helpStamp } = require('./tools');

/** Wait after an instance came up or changed before asking it: it answers messages only once it runs. */
const FIRST_ASK_MS = 5000;
/** Ask once more after this when it did not answer the first time (a slow start). */
const SECOND_ASK_MS = 20_000;
/** The alive state of an instance, e.g. system.adapter.youtube-remote.0.alive */
const ALIVE = /^system\.adapter\.([a-z0-9][a-z0-9_-]*\.\d+)\.alive$/;
/** The object of an instance, e.g. system.adapter.youtube-remote.0 */
const INSTANCE_OBJECT = /^system\.adapter\.([a-z0-9][a-z0-9_-]*\.\d+)$/;
const HIGHEST_KEY_CHAR = '香';
/** Why an instance left the list, by the status of readHelp. */
const GONE = {
    missing: 'was deleted',
    'not declared': 'no longer declares a help',
    'no help': 'answered "help" without a help',
    'no messages': 'describes no states any more',
};

/**
 * The instances that describe themselves (adapter_help) with a stamp of their help as it is now. Read at the start
 * of pi-agent and again when an instance restarts or its object changes (an update, a new installation, switched
 * off, deleted): an instance that still declares a help is asked again, one that no longer does leaves the list.
 * A changed stamp tells the conversations that used the instance to read its help again (lib/adapter-knowledge.js).
 *
 * @param {ioBroker.Adapter} adapter pi-agent
 * @returns {{
 *   start: () => Promise<number>,
 *   handlesState: (id: string) => boolean,
 *   handlesObject: (id: string) => boolean,
 *   onAlive: (id: string, state: ioBroker.State | null | undefined) => void,
 *   onObject: (id: string, obj: ioBroker.Object | null | undefined) => void,
 *   set: (instance: string, stamp: string) => void,
 *   stamps: () => Map<string, string>,
 *   refresh: (instance: string) => Promise<string>,
 *   stop: () => void,
 * }} the registry
 */
function createHelpRegistry(adapter) {
    /** instance -> helpStamp of its help */
    const helps = new Map();
    /** instance -> whether it ran at the last alive value seen */
    const alive = new Map();
    /** instance -> pending ask */
    const timers = new Map();
    let stopped = false;

    const remove = (instance, why) => {
        if (!helps.delete(instance)) {
            return false;
        }
        adapter.log.info(`${instance} ${why}: removed from the instances that describe themselves`);
        return true;
    };

    /**
     * Ask the instance for its help and update the list.
     *
     * @param {string} instance e.g. "youtube-remote.0"
     * @returns {Promise<'read' | 'changed' | 'unchanged' | 'removed' | 'none' | 'no answer'>} what happened
     */
    async function refresh(instance) {
        let read;
        try {
            read = await readHelp(adapter, instance, { declaredOnly: true });
        } catch (e) {
            adapter.log.debug(`Help of ${instance} not read: ${e.message}`);
            return 'no answer';
        }
        if (stopped) {
            return 'none';
        }
        if (read.status === 'help' || read.status === 'states') {
            const stamp = helpStamp(read.text);
            const before = helps.get(instance);
            helps.set(instance, stamp);
            if (before === undefined) {
                adapter.log.debug(`Help of ${instance} read (${read.text.length} characters)`);
                return 'read';
            }
            if (before !== stamp) {
                adapter.log.info(
                    `The help of ${instance} changed: conversations that used it are told to read it again`,
                );
                return 'changed';
            }
            return 'unchanged';
        }
        if (read.status === 'stopped') {
            // a restart keeps the help until the instance runs again; a switched off instance leaves the list
            return read.common?.enabled === false && remove(instance, 'was switched off') ? 'removed' : 'no answer';
        }
        if (read.status === 'no answer') {
            return 'no answer';
        }
        return remove(instance, GONE[read.status] ?? 'gives no help any more') ? 'removed' : 'none';
    }

    /**
     * Ask the instance a little later, once more if it did not answer; a newer event replaces the pending ask.
     *
     * @param {string} instance e.g. "youtube-remote.0"
     */
    function schedule(instance) {
        const ask = (delay, again) => {
            const pending = timers.get(instance);
            if (pending) {
                adapter.clearTimeout(pending);
            }
            timers.set(
                instance,
                adapter.setTimeout(() => {
                    timers.delete(instance);
                    void refresh(instance).then(result => {
                        if (result === 'no answer' && again && !stopped) {
                            ask(SECOND_ASK_MS, false);
                        }
                    });
                }, delay),
            );
        };
        ask(FIRST_ASK_MS, true);
    }

    return {
        /**
         * Read the helps of all instances that may describe themselves. Subscribe to system.adapter.*.alive and
         * the objects system.adapter.* before, so no restart is missed meanwhile.
         *
         * @returns {Promise<number>} how many instances describe themselves
         */
        async start() {
            try {
                // which instances run now, so their next alive (every 15 s) is no start; unknown ones are asked once
                const states = await adapter.getForeignStatesAsync('system.adapter.*.alive');
                for (const [id, state] of Object.entries(states || {})) {
                    const instance = ALIVE.exec(id)?.[1];
                    if (instance && !alive.has(instance)) {
                        alive.set(instance, state?.val === true);
                    }
                }
            } catch (e) {
                adapter.log.debug(`Cannot read which instances run: ${e.message}`);
            }
            try {
                const view = await adapter.getObjectViewAsync('system', 'instance', {
                    startkey: 'system.adapter.',
                    endkey: `system.adapter.${HIGHEST_KEY_CHAR}`,
                });
                for (const { id, value } of view?.rows || []) {
                    const instance = INSTANCE_OBJECT.exec(id)?.[1];
                    if (stopped) {
                        break;
                    }
                    if (
                        instance &&
                        instance !== adapter.namespace &&
                        value?.common &&
                        mayDescribeItself(value.common)
                    ) {
                        await refresh(instance);
                    }
                }
            } catch (e) {
                adapter.log.warn(`Cannot read the helps of the instances: ${e.message}`);
            }
            return helps.size;
        },

        handlesState: id => ALIVE.test(id),

        handlesObject: id => INSTANCE_OBJECT.test(id),

        /**
         * An instance came up (alive turned true): ask it again, its help may have changed with an update.
         *
         * @param {string} id e.g. system.adapter.youtube-remote.0.alive
         * @param {ioBroker.State | null | undefined} state the new value
         */
        onAlive(id, state) {
            const instance = ALIVE.exec(id)?.[1];
            if (!instance || instance === adapter.namespace || stopped) {
                return;
            }
            const up = state?.val === true;
            const was = alive.get(instance);
            alive.set(instance, up);
            if (up && was !== true) {
                schedule(instance);
            }
        },

        /**
         * The object of an instance changed: deleted leaves the list, anything else is asked again (a web-only
         * adapter has no process whose restart would tell it).
         *
         * @param {string} id e.g. system.adapter.home3d.0
         * @param {ioBroker.Object | null | undefined} obj the object as it is now, null when deleted
         */
        onObject(id, obj) {
            const instance = INSTANCE_OBJECT.exec(id)?.[1];
            if (!instance || instance === adapter.namespace || stopped) {
                return;
            }
            if (!obj) {
                const pending = timers.get(instance);
                if (pending) {
                    adapter.clearTimeout(pending);
                    timers.delete(instance);
                }
                alive.delete(instance);
                remove(instance, GONE.missing);
                return;
            }
            if (helps.has(instance) || (obj.type === 'instance' && mayDescribeItself(obj.common))) {
                schedule(instance);
            }
        },

        /**
         * adapter_help read the help just now.
         *
         * @param {string} instance e.g. "youtube-remote.0"
         * @param {string} stamp helpStamp of it
         */
        set(instance, stamp) {
            helps.set(instance, stamp);
        },

        stamps: () => new Map(helps),

        refresh,

        /** No more asks (unload). */
        stop() {
            stopped = true;
            for (const pending of timers.values()) {
                adapter.clearTimeout(pending);
            }
            timers.clear();
        },
    };
}

module.exports = { createHelpRegistry, FIRST_ASK_MS, SECOND_ASK_MS };
