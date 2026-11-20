'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * What each conversation knows of the adapter instances that describe themselves (adapter_help), so the agent hears
 * when one was updated after a conversation used it: what the conversation found or said about it before may be
 * wrong now. Seen with youtube-remote: a voice conversation had found "it takes only exact links"; after an update
 * that added a search, the agent answered from that, without calling a single tool.
 *
 * Per conversation and instance it keeps the stamp of the help the conversation knows (helpStamp in lib/tools.js,
 * the current ones come from lib/help-registry.js): the one of its first use, replaced only when the conversation
 * reads the help again. The file survives restarts, as the conversations do.
 */

const FILE = 'adapter-knowledge.json';
/** Conversations kept; the ones changed least recently are dropped first. */
const MAX_CONVERSATIONS = 300;
/** The instance of an object or state id, e.g. "youtube-remote.0" of "youtube-remote.0.tv_1.youtube". */
const INSTANCE_OF_ID = /^([a-z0-9][a-z0-9_-]*\.\d+)(?:\.|$)/;

/**
 * @param {unknown} id object or state id, or an instance; patterns with "*" after the instance work too
 * @returns {string} the instance, e.g. "youtube-remote.0", or "" for system objects, aliases and the like
 */
function instanceOfId(id) {
    return INSTANCE_OF_ID.exec(String(id ?? '').replace(/^system\.adapter\./, ''))?.[1] ?? '';
}

/**
 * @param {string} dir instance data directory ("" in tests: nothing is written)
 * @returns {{
 *   load: () => void,
 *   used: (conversation: unknown, instance: string, stamp: string) => void,
 *   read: (conversation: unknown, instance: string, stamp: string) => void,
 *   outdated: (conversation: unknown, stamps: Map<string, string>) => string[],
 * }} the knowledge of all conversations
 */
function createAdapterKnowledge(dir) {
    const file = dir ? path.join(dir, FILE) : '';
    /** conversation -> instance -> stamp; the order of the map is the order of the last change */
    let seen = new Map();

    const save = () => {
        if (!file) {
            return;
        }
        const data = Object.fromEntries(
            [...seen].map(([conversation, known]) => [conversation, Object.fromEntries(known)]),
        );
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data));
        } catch {
            // only a hint gets lost: the conversation may miss once that an adapter changed
        }
    };

    const set = (conversation, instance, stamp) => {
        const key = String(conversation ?? '');
        if (!key || !instance) {
            return;
        }
        const known = seen.get(key) ?? new Map();
        if (known.get(instance) === stamp) {
            return;
        }
        known.set(instance, stamp);
        seen.delete(key);
        seen.set(key, known);
        while (seen.size > MAX_CONVERSATIONS) {
            seen.delete(seen.keys().next().value);
        }
        save();
    };

    return {
        /** Read the file; an unreadable one starts empty. */
        load() {
            seen = new Map();
            if (!file) {
                return;
            }
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const [conversation, known] of Object.entries(Object(data))) {
                    const entries = Object.entries(Object(known)).filter(([, stamp]) => typeof stamp === 'string');
                    if (entries.length) {
                        seen.set(conversation, new Map(entries));
                    }
                }
            } catch {
                seen = new Map();
            }
        },

        /**
         * The conversation used the instance (wrote or read its states, sent it a command). It knows the help
         * of its first use until it reads the help again: a later use does not tell it what changed.
         *
         * @param {unknown} conversation conversation id
         * @param {string} instance e.g. "youtube-remote.0"
         * @param {string} stamp helpStamp of the help now
         */
        used(conversation, instance, stamp) {
            if (!seen.get(String(conversation ?? ''))?.has(instance)) {
                set(conversation, instance, stamp);
            }
        },

        /**
         * The conversation read the help of the instance: it knows the help of now.
         *
         * @param {unknown} conversation conversation id
         * @param {string} instance e.g. "youtube-remote.0"
         * @param {string} stamp helpStamp of the help now
         */
        read(conversation, instance, stamp) {
            set(conversation, instance, stamp);
        },

        /**
         * @param {unknown} conversation conversation id
         * @param {Map<string, string>} stamps instance -> helpStamp now, of the instances that describe themselves
         * @returns {string[]} the instances whose help changed since the conversation used them or read it, sorted
         */
        outdated(conversation, stamps) {
            const known = seen.get(String(conversation ?? ''));
            if (!known) {
                return [];
            }
            return [...known]
                .filter(([instance, stamp]) => stamps.has(instance) && stamps.get(instance) !== stamp)
                .map(([instance]) => instance)
                .sort();
        },
    };
}

module.exports = { createAdapterKnowledge, instanceOfId, MAX_CONVERSATIONS };
