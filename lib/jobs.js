'use strict';

/**
 * Background jobs: a task of the user that runs for days ("while I am away, tell me when a window stays open while the
 * heating runs"). The adapter watches the triggers of a job itself, without the model; only when a trigger fires is
 * the job's own conversation woken up, and the agent there decides what to tell the user.
 *
 * Triggers: a state that meets a condition (like notify_when, but again after the condition broke off), a time of
 * day, or an interval. A job ends after at most 30 days; at most MAX_JOBS run at the same time, and a job that wakes
 * up more than MAX_WAKES_PER_DAY times in one day is paused, so a flapping sensor cannot use up the budget.
 *
 * The jobs are kept in the state scheduled.jobs, so they survive a restart of the adapter; their timers and
 * subscriptions start again at the start.
 */

const crypto = require('node:crypto');
const { CONDITIONS, meets } = require('./watches');
const { parseLocalTime, formatLocal } = require('./time');

/** At most this many jobs at the same time. */
const MAX_JOBS = 5;
/** At most this many triggers per job. */
const MAX_TRIGGERS = 5;
/** A job that wakes up more often than this in one day (local time of the house) is paused. */
const MAX_WAKES_PER_DAY = 20;
/** The longest lifetime of a job, in days. */
const MAX_DAYS = 30;
/** The shortest interval of a trigger "interval", in minutes. */
const MIN_INTERVAL_MINUTES = 15;
/** The longest "for" duration of a state condition. */
const MAX_FOR_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/**
 * Local date of the house, for counting the wakes of a day.
 *
 * @param {number} ts instant
 * @param {string} zone IANA time zone
 * @returns {string} "2026-11-02"
 */
function localDay(ts, zone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(ts));
}

/**
 * A trigger as the model gives it, checked and normalized.
 *
 * @param {Record<string, unknown>} raw trigger of the tool call
 * @returns {{ kind: 'state', stateId: string, condition: string, value: unknown, forMs: number } | { kind: 'daily', time: string } | { kind: 'interval', minutes: number }} trigger
 */
function normalizeTrigger(raw) {
    const kind = String(raw?.kind ?? '').trim();
    if (kind === 'state') {
        const stateId = String(raw.id ?? '').trim();
        const condition = String(raw.condition ?? '').trim();
        if (!stateId) {
            throw new Error('A trigger "state" needs the "id" of the state');
        }
        if (!CONDITIONS.includes(condition)) {
            throw new Error(`The condition must be one of ${CONDITIONS.join(' ')}`);
        }
        if (condition !== 'changes' && raw.value === undefined) {
            throw new Error('The condition needs a value');
        }
        const forMs = Math.round(Math.max(Number(raw.minutes) || 0, 0) * 60_000);
        if (forMs > MAX_FOR_MS) {
            throw new Error('The duration of a condition may be at most 24 hours');
        }
        return { kind, stateId, condition, value: condition === 'changes' ? null : raw.value, forMs };
    }
    if (kind === 'daily') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time ?? '').trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
            throw new Error('A trigger "daily" needs "time" as local time "HH:MM", e.g. "07:00"');
        }
        return { kind, time: `${m[1].padStart(2, '0')}:${m[2]}` };
    }
    if (kind === 'interval') {
        const minutes = Math.round(Number(raw.minutes));
        if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > 24 * 60) {
            throw new Error(`A trigger "interval" needs "minutes" from ${MIN_INTERVAL_MINUTES} to 1440`);
        }
        return { kind, minutes };
    }
    throw new Error('The kind of a trigger must be "state", "daily" or "interval"');
}

/**
 * A trigger in words, for the wake message, list_jobs and the log.
 *
 * @param {object} trigger normalized trigger
 * @returns {string} e.g. "hm-rpc.0.window.STATE == true for 15 minute(s)"
 */
function triggerText(trigger) {
    if (trigger.kind === 'daily') {
        return `every day at ${trigger.time}`;
    }
    if (trigger.kind === 'interval') {
        return `every ${trigger.minutes} minutes`;
    }
    const condition =
        trigger.condition === 'changes' ? 'changes' : `${trigger.condition} ${JSON.stringify(trigger.value)}`;
    const duration = trigger.forMs ? ` for ${Math.round(trigger.forMs / 60_000)} minute(s)` : '';
    return `${trigger.stateId} ${condition}${duration}`;
}

/**
 * The jobs of an adapter instance.
 *
 * @param {object} adapter adapter instance (states, subscriptions, timers, log)
 * @param {object} hooks what the adapter does for the jobs
 * @param {(job: object, reason: string) => Promise<void>} hooks.wake wake the job's conversation: a trigger fired
 * @param {(job: object, text: string) => Promise<void>} hooks.tell send a message of the adapter to the user of a job
 * @param {() => string} hooks.timeZone time zone of the house
 * @param {(stateId: string) => boolean} [hooks.inUse] whether something else still needs the subscription of a state
 * @returns {object} jobs
 */
function createJobs(adapter, { wake, tell, timeZone, inUse = () => false }) {
    let jobs = [];
    /** "<job id>/<trigger index>" -> timer (a "for" duration, the next time of day, the next interval) */
    const timers = new Map();
    let expiry;

    const save = () => adapter.setStateAsync('scheduled.jobs', { val: JSON.stringify(jobs), ack: true });
    const zone = () => timeZone() || 'UTC';
    const stateIdsOf = job => job.triggers.filter(t => t.kind === 'state').map(t => t.stateId);
    const handles = stateId => jobs.some(j => !j.paused && stateIdsOf(j).includes(stateId));

    const stopTimer = key => {
        if (timers.has(key)) {
            adapter.clearTimeout(timers.get(key));
            timers.delete(key);
        }
    };
    const stopTimersOf = job => {
        for (const key of [...timers.keys()].filter(k => k.startsWith(`${job.id}/`))) {
            stopTimer(key);
        }
    };
    const unsubscribeUnused = async stateIds => {
        for (const stateId of new Set(stateIds)) {
            if (!handles(stateId) && !inUse(stateId)) {
                await adapter.unsubscribeForeignStatesAsync(stateId).catch(() => undefined);
            }
        }
    };

    /**
     * A trigger fired: count the wake of the day, pause the job when there were too many, else wake it.
     *
     * @param {object} job the job
     * @param {string} reason what fired, in words
     */
    const fire = async (job, reason) => {
        if (!jobs.includes(job) || job.paused) {
            return;
        }
        const day = localDay(Date.now(), zone());
        if (job.day !== day) {
            job.day = day;
            job.wakes = 0;
        }
        if (job.wakes >= MAX_WAKES_PER_DAY) {
            await pause(job);
            adapter.log.warn(`Job ${job.id} "${job.name}" paused: woken ${MAX_WAKES_PER_DAY} times today`);
            await tell(
                job,
                `Job "${job.name}" was woken ${MAX_WAKES_PER_DAY} times today and is paused, so a flapping trigger does not use up the budget. Say "resume job ${job.id}" to go on, or stop it.`,
            );
            return;
        }
        job.wakes += 1;
        job.total = (job.total || 0) + 1;
        job.seq = (job.seq || 0) + 1;
        job.last = Date.now();
        job.lastReason = reason;
        await save();
        adapter.log.info(`Job ${job.id} "${job.name}" woken (${job.wakes}/${MAX_WAKES_PER_DAY} today): ${reason}`);
        await wake(job, reason);
    };

    /**
     * Plan the next run of a time trigger.
     *
     * @param {object} job the job
     * @param {number} index index of the trigger
     */
    const planTime = (job, index) => {
        const trigger = job.triggers[index];
        const key = `${job.id}/${index}`;
        stopTimer(key);
        const now = Date.now();
        const at =
            trigger.kind === 'daily'
                ? parseLocalTime(trigger.time, zone(), now)
                : trigger.next && trigger.next > now
                  ? trigger.next
                  : now + trigger.minutes * 60_000;
        if (trigger.kind === 'interval') {
            trigger.next = at;
        }
        timers.set(
            key,
            adapter.setTimeout(
                () => {
                    timers.delete(key);
                    if (trigger.kind === 'interval') {
                        trigger.next = Date.now() + trigger.minutes * 60_000;
                    }
                    planTime(job, index);
                    void fire(job, triggerText(trigger)).catch(e =>
                        adapter.log.warn(`Job ${job.id} failed: ${e.message}`),
                    );
                },
                Math.max(at - now, 1000),
            ),
        );
    };

    /**
     * A new value for a state trigger. It fires when the condition becomes met (and holds for its duration), and
     * again only after the condition broke off; "changes" fires at every new value.
     *
     * @param {object} job the job
     * @param {number} index index of the trigger
     * @param {unknown} val value of the device
     */
    const check = async (job, index, val) => {
        const trigger = job.triggers[index];
        const key = `${job.id}/${index}`;
        if (trigger.condition === 'changes') {
            const changed = trigger.last !== undefined && JSON.stringify(trigger.last) !== JSON.stringify(val);
            trigger.last = val;
            await save();
            if (changed) {
                await fire(job, `${triggerText(trigger)}: now ${JSON.stringify(val)}`);
            }
            return;
        }
        if (!meets(val, trigger.condition, trigger.value)) {
            stopTimer(key);
            if (trigger.met) {
                trigger.met = false; // broke off: the next time it is met counts again
                await save();
            }
            return;
        }
        if (trigger.met || timers.has(key)) {
            return;
        }
        const met = async () => {
            trigger.met = true;
            await fire(job, `${triggerText(trigger)}: now ${JSON.stringify(val)}`);
        };
        if (!trigger.forMs) {
            await met();
            return;
        }
        timers.set(
            key,
            adapter.setTimeout(() => {
                timers.delete(key);
                void met().catch(e => adapter.log.warn(`Job ${job.id} failed: ${e.message}`));
            }, trigger.forMs),
        );
    };

    /**
     * Start the triggers of a job: subscribe its states, check their values, plan its times.
     *
     * @param {object} job the job
     */
    const start = async job => {
        for (const [index, trigger] of job.triggers.entries()) {
            if (trigger.kind !== 'state') {
                planTime(job, index);
                continue;
            }
            await adapter.subscribeForeignStatesAsync(trigger.stateId);
            const state = await adapter.getForeignStateAsync(trigger.stateId);
            if (state && (trigger.condition !== 'changes' || trigger.last === undefined)) {
                await check(job, index, state.val);
            }
        }
    };

    /**
     * Stop the triggers of a job and keep it.
     *
     * @param {object} job the job
     */
    async function pause(job) {
        job.paused = true;
        stopTimersOf(job);
        await save();
        await unsubscribeUnused(stateIdsOf(job));
    }

    /**
     * Remove a job.
     *
     * @param {object} job the job
     */
    const end = async job => {
        stopTimersOf(job);
        jobs = jobs.filter(j => j !== job);
        await save();
        await unsubscribeUnused(stateIdsOf(job));
    };

    /** End the jobs whose time ran out, and plan the next check. */
    const expire = async () => {
        adapter.clearTimeout(expiry);
        const now = Date.now();
        for (const job of jobs.filter(j => j.until <= now)) {
            adapter.log.info(`Job ${job.id} "${job.name}" ended: its time ran out`);
            await end(job);
            await tell(job, `Job "${job.name}" has ended: its time ran out.`);
        }
        if (jobs.length) {
            const next = Math.min(...jobs.map(j => j.until)) - now;
            expiry = adapter.setTimeout(() => void expire(), Math.min(Math.max(next, 1000), DAY_MS));
        }
    };

    const find = id => jobs.find(j => j.id === String(id ?? '').trim());

    return {
        /** Read the stored jobs and start their triggers. */
        async load() {
            try {
                const stored = (await adapter.getStateAsync('scheduled.jobs'))?.val;
                const list = stored ? JSON.parse(String(stored)) : [];
                jobs = Array.isArray(list)
                    ? list.filter(j => j && j.id && j.conversationId && Array.isArray(j.triggers))
                    : [];
            } catch {
                jobs = [];
            }
            await expire();
            for (const job of jobs.filter(j => !j.paused)) {
                await start(job);
            }
        },

        /**
         * @param {string} stateId state id
         * @returns {boolean} true when a running job has a trigger on this state
         */
        handles,

        /**
         * A state of a trigger changed; only values of the device (ack=true) count.
         *
         * @param {string} stateId state id
         * @param {ioBroker.State | null | undefined} state new state
         */
        async onState(stateId, state) {
            if (!state || !state.ack) {
                return;
            }
            for (const job of jobs.filter(j => !j.paused)) {
                for (const [index, trigger] of job.triggers.entries()) {
                    if (trigger.kind === 'state' && trigger.stateId === stateId) {
                        await check(job, index, state.val);
                    }
                }
            }
        },

        /**
         * Check a new job before its conversation is created.
         *
         * @param {{ name: string, triggers: unknown[], days?: number }} request what the model asked for
         * @returns {{ name: string, triggers: object[], days: number }} normalized
         */
        validate(request) {
            if (jobs.length >= MAX_JOBS) {
                throw new Error(`There are already ${MAX_JOBS} jobs; stop one first (list_jobs, stop_job)`);
            }
            const raw = Array.isArray(request.triggers) ? request.triggers : [];
            if (raw.length === 0 || raw.length > MAX_TRIGGERS) {
                throw new Error(`A job needs 1 to ${MAX_TRIGGERS} triggers`);
            }
            const days = request.days === undefined ? MAX_DAYS : Number(request.days);
            if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) {
                throw new Error(`A job runs at most ${MAX_DAYS} days`);
            }
            const name = String(request.name ?? '')
                .trim()
                .slice(0, 60);
            if (!name) {
                throw new Error('The job needs a short name');
            }
            return { name, triggers: raw.map(t => normalizeTrigger(Object(t))), days };
        },

        /**
         * Add a checked job and start its triggers.
         *
         * @param {{ name: string, task: string, triggers: object[], days: number, owner: string, conversationId: string, notify: string[] }} request job
         * @returns {Promise<object>} the job
         */
        async add(request) {
            const now = Date.now();
            const job = {
                id: `j${crypto.randomBytes(3).toString('hex')}`,
                name: request.name,
                task: String(request.task).slice(0, 2000),
                owner: String(request.owner),
                conversationId: String(request.conversationId),
                notify: request.notify,
                triggers: request.triggers,
                created: now,
                until: now + request.days * DAY_MS,
                paused: false,
                day: localDay(now, zone()),
                wakes: 0,
                total: 0,
                seq: 0,
            };
            jobs = [...jobs, job];
            await save();
            await expire();
            await start(job);
            adapter.log.info(`Job ${job.id} "${job.name}" created: ${job.triggers.map(triggerText).join('; ')}`);
            return job;
        },

        /** @returns {object[]} all jobs */
        list: () => jobs,

        /**
         * @param {unknown} id job id
         * @returns {object | undefined} the job
         */
        get: find,

        /**
         * @param {unknown} conversationId conversation id
         * @returns {object | undefined} the job this conversation belongs to
         */
        byConversation: conversationId => jobs.find(j => j.conversationId === String(conversationId)),

        /**
         * Stop and remove a job.
         *
         * @param {unknown} id job id
         * @returns {Promise<object | undefined>} the removed job
         */
        async remove(id) {
            const job = find(id);
            if (job) {
                await end(job);
                adapter.log.info(`Job ${job.id} "${job.name}" stopped`);
            }
            return job;
        },

        /**
         * Start a paused job again; the count of the day starts over.
         *
         * @param {unknown} id job id
         * @returns {Promise<object | undefined>} the job
         */
        async resume(id) {
            const job = find(id);
            if (job?.paused) {
                job.paused = false;
                job.wakes = 0;
                job.day = localDay(Date.now(), zone());
                await save();
                await start(job);
                adapter.log.info(`Job ${job.id} "${job.name}" resumed`);
            }
            return job;
        },

        /**
         * A job for the model: what it does, its triggers, when it ends.
         *
         * @param {object} job the job
         * @returns {object} row
         */
        row(job) {
            return {
                id: job.id,
                name: job.name,
                task: job.task,
                triggers: job.triggers.map(triggerText),
                status: job.paused ? 'paused' : 'running',
                until: formatLocal(job.until, zone()),
                wakesToday: job.day === localDay(Date.now(), zone()) ? job.wakes : 0,
                wakesTotal: job.total || 0,
                last: job.last ? `${formatLocal(job.last, zone())}: ${job.lastReason}` : undefined,
                notify: job.notify,
            };
        },

        /** Stop all timers (the jobs stay stored). */
        stop() {
            for (const key of [...timers.keys()]) {
                stopTimer(key);
            }
            adapter.clearTimeout(expiry);
        },
    };
}

module.exports = {
    MAX_JOBS,
    MAX_TRIGGERS,
    MAX_WAKES_PER_DAY,
    MAX_DAYS,
    MIN_INTERVAL_MINUTES,
    normalizeTrigger,
    triggerText,
    localDay,
    createJobs,
};
