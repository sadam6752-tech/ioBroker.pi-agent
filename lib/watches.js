'use strict';

/**
 * Watches of the tool notify_when: tell the user in the chat of a conversation when a state meets a condition, e.g.
 * "the power of the washing machine is below 5 W for 3 minutes" or "the window is open for more than 10 minutes".
 *
 * A watch waits for a value of the device (ack=true), so a command that was only sent does not count. It fires once and
 * ends; one that never fires ends after at most 7 days. The watches are kept in the state scheduled.watches, so they
 * survive a restart of the adapter; their timers start again at the start.
 */

const crypto = require('node:crypto');

/** At most this many watches at the same time (each one subscribes a state). */
const MAX_WATCHES = 20;
/** A watch ends after this time at the latest. */
const MAX_LIFETIME_MS = 7 * 24 * 3_600_000;
/** The longest "for" duration of a condition. */
const MAX_FOR_MS = 24 * 3_600_000;
/** Conditions a watch understands. */
const CONDITIONS = ['==', '!=', '>', '<', '>=', '<=', 'changes'];

/**
 * Whether a value meets a condition. Numbers are compared as numbers, true/false also as "true"/"false" and 1/0.
 *
 * @param {unknown} val current value
 * @param {string} condition one of CONDITIONS (not "changes")
 * @param {unknown} expected value of the condition
 * @returns {boolean} true when met
 */
function meets(val, condition, expected) {
    const asBool = v =>
        v === true || v === 'true' || v === 1 || v === '1'
            ? true
            : v === false || v === 'false' || v === 0 || v === '0'
              ? false
              : null;
    if (condition === '==' || condition === '!=') {
        const a = typeof val === 'boolean' || typeof expected === 'boolean' ? asBool(val) : val;
        const b = typeof val === 'boolean' || typeof expected === 'boolean' ? asBool(expected) : expected;
        // numbers given as text by the model ("5") compare as numbers
        const equal =
            typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b);
        return condition === '==' ? equal : !equal;
    }
    const a = Number(val);
    const b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return false;
    }
    return condition === '>' ? a > b : condition === '<' ? a < b : condition === '>=' ? a >= b : a <= b;
}

/**
 * The watches of an adapter instance.
 *
 * @param {object} adapter adapter instance (states, subscriptions, timers, log)
 * @param {(conversationId: unknown, text: string) => Promise<void>} deliver sends the message into the chat of a conversation
 * @returns {object} watches
 */
function createWatches(adapter, deliver) {
    let watches = [];
    /** watch id -> timer of its "for" duration */
    const timers = new Map();
    let expiry;

    const save = () => adapter.setStateAsync('scheduled.watches', { val: JSON.stringify(watches), ack: true });

    /**
     * Subscribe the state of a watch unless another watch already does.
     *
     * @param {string} stateId state of the watch
     */
    const subscribe = async stateId => {
        await adapter.subscribeForeignStatesAsync(stateId);
    };
    const unsubscribe = async stateId => {
        if (!watches.some(w => w.stateId === stateId)) {
            await adapter.unsubscribeForeignStatesAsync(stateId).catch(() => undefined);
        }
    };

    const stopTimer = id => {
        if (timers.has(id)) {
            adapter.clearTimeout(timers.get(id));
            timers.delete(id);
        }
    };

    /**
     * End a watch: remove it, stop its timer, unsubscribe its state when no other watch needs it.
     *
     * @param {object} watch the watch
     */
    const end = async watch => {
        stopTimer(watch.id);
        watches = watches.filter(w => w.id !== watch.id);
        await save();
        await unsubscribe(watch.stateId);
    };

    /**
     * The condition is met (for long enough): tell the user and end the watch.
     *
     * @param {object} watch the watch
     * @param {unknown} val value that met the condition
     */
    const fire = async (watch, val) => {
        if (!watches.some(w => w.id === watch.id)) {
            return;
        }
        await end(watch);
        adapter.log.info(`Watch ${watch.id} on ${watch.stateId} fired (value ${JSON.stringify(val)})`);
        await deliver(watch.conversationId, `🔔 ${watch.text} (${watch.stateId} = ${JSON.stringify(val)})`);
    };

    /**
     * A new value of the state of a watch.
     *
     * @param {object} watch the watch
     * @param {unknown} val new value of the state
     */
    const check = async (watch, val) => {
        if (watch.condition === 'changes') {
            const changed = watch.last !== undefined && JSON.stringify(watch.last) !== JSON.stringify(val);
            if (watch.last === undefined || !changed) {
                watch.last = val;
                await save();
                return;
            }
            return fire(watch, val);
        }
        if (!meets(val, watch.condition, watch.value)) {
            stopTimer(watch.id); // the condition broke off: the duration starts again next time
            return;
        }
        if (!watch.forMs) {
            return fire(watch, val);
        }
        if (!timers.has(watch.id)) {
            timers.set(
                watch.id,
                adapter.setTimeout(() => {
                    timers.delete(watch.id);
                    void fire(watch, val).catch(e => adapter.log.warn(`Watch ${watch.id} failed: ${e.message}`));
                }, watch.forMs),
            );
        }
    };

    /** Remove the watches whose time ran out, and plan the next check. */
    const expire = async () => {
        adapter.clearTimeout(expiry);
        const now = Date.now();
        for (const watch of watches.filter(w => w.until <= now)) {
            adapter.log.info(`Watch ${watch.id} on ${watch.stateId} ended without firing (7 days)`);
            await end(watch);
        }
        if (watches.length) {
            const next = Math.min(...watches.map(w => w.until)) - now;
            expiry = adapter.setTimeout(() => void expire(), Math.min(Math.max(next, 1000), 24 * 3_600_000));
        }
    };

    return {
        /** Read the stored watches, subscribe their states and check their current values. */
        async load() {
            try {
                const stored = (await adapter.getStateAsync('scheduled.watches'))?.val;
                const list = stored ? JSON.parse(String(stored)) : [];
                watches = Array.isArray(list)
                    ? list.filter(w => w && w.id && w.stateId && CONDITIONS.includes(w.condition))
                    : [];
            } catch {
                watches = [];
            }
            await expire();
            for (const stateId of new Set(watches.map(w => w.stateId))) {
                await subscribe(stateId);
                const state = await adapter.getForeignStateAsync(stateId);
                for (const watch of watches.filter(w => w.stateId === stateId)) {
                    if (state && (watch.condition !== 'changes' || watch.last === undefined)) {
                        await check(watch, state.val);
                    }
                }
            }
        },

        /**
         * @param {string} stateId state id
         * @returns {boolean} true when a watch looks at this state
         */
        handles: stateId => watches.some(w => w.stateId === stateId),

        /**
         * A state of a watch changed; only values of the device (ack=true) count.
         *
         * @param {string} stateId state id
         * @param {ioBroker.State | null | undefined} state new state
         */
        async onState(stateId, state) {
            if (!state || !state.ack) {
                return;
            }
            for (const watch of watches.filter(w => w.stateId === stateId)) {
                await check(watch, state.val);
            }
        },

        /**
         * Add a watch for a conversation.
         *
         * @param {{ conversationId: unknown, stateId: string, condition: string, value?: unknown, minutes?: number, text: string }} request what to watch
         * @returns {Promise<string>} what happened, for the model
         */
        async add(request) {
            if (!CONDITIONS.includes(request.condition)) {
                throw new Error(`The condition must be one of ${CONDITIONS.join(' ')}`);
            }
            if (request.condition !== 'changes' && request.value === undefined) {
                throw new Error('The condition needs a value');
            }
            if (watches.length >= MAX_WATCHES) {
                throw new Error(
                    `There are already ${MAX_WATCHES} watches; cancel one first (list_scheduled, cancel_scheduled)`,
                );
            }
            const forMs = Math.round(Math.max(Number(request.minutes) || 0, 0) * 60_000);
            if (forMs > MAX_FOR_MS) {
                throw new Error('The duration may be at most 24 hours');
            }
            const now = Date.now();
            const watch = {
                id: `w${crypto.randomBytes(3).toString('hex')}`,
                conversationId: String(request.conversationId),
                stateId: request.stateId,
                condition: request.condition,
                value: request.condition === 'changes' ? null : request.value,
                forMs,
                text: String(request.text || 'Condition met').slice(0, 300),
                created: now,
                until: now + MAX_LIFETIME_MS,
            };
            watches = [...watches, watch];
            await save();
            await subscribe(watch.stateId);
            await expire();
            // a condition that is already met counts from now
            const state = await adapter.getForeignStateAsync(watch.stateId);
            if (state) {
                await check(watch, state.val);
            }
            const fired = !watches.some(w => w.id === watch.id);
            return fired
                ? `The condition is already met; the user was told at once.`
                : `Watch ${watch.id} set: the user gets a message in this chat when ${watch.stateId} ${watch.condition === 'changes' ? 'changes' : `${watch.condition} ${JSON.stringify(watch.value)}`}${forMs ? ` for ${Math.round(forMs / 60_000)} minute(s)` : ''}. It ends after firing once, at the latest in 7 days.`;
        },

        /**
         * The watches of a conversation.
         *
         * @param {unknown} conversationId conversation
         * @returns {Array<object>} watches
         */
        list: conversationId => watches.filter(w => w.conversationId === String(conversationId)),

        /**
         * Cancel a watch of a conversation.
         *
         * @param {unknown} conversationId conversation
         * @param {string} id watch id
         * @returns {Promise<boolean>} true when there was one
         */
        async cancel(conversationId, id) {
            const watch = watches.find(w => w.id === id && w.conversationId === String(conversationId));
            if (!watch) {
                return false;
            }
            await end(watch);
            return true;
        },

        /** Stop all timers (the watches stay stored). */
        stop() {
            for (const id of [...timers.keys()]) {
                stopTimer(id);
            }
            adapter.clearTimeout(expiry);
        },
    };
}

module.exports = { CONDITIONS, MAX_WATCHES, meets, createWatches };
