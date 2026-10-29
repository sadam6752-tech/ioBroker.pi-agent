'use strict';

const { isRestartable, isWriteAllowed } = require('./guard');
const path = require('node:path');
const { parseLocalTime, formatLocal } = require('./time');
const { readLog, flattenNotifications } = require('./diagnostics');

const MAX_RESULTS = 50;
/** How long send_to waits for the answer of the other adapter. */
const SEND_TO_TIMEOUT_MS = 30_000;
/** Longest answer of another adapter that goes back to the model. */
const MAX_ANSWER = 4000;
/** Upper bound for object view key ranges (CouchDB convention). */
const HIGHEST_KEY_CHAR = String.fromCharCode(0x9999);

/**
 * Plain text of an ioBroker name, which may be a translated object.
 *
 * @param {ioBroker.StringOrTranslated | null | undefined} name common.name
 * @returns {string} name in English, else the first language
 */
function nameText(name) {
    if (name && typeof name === 'object') {
        return name.en || Object.values(name)[0] || '';
    }
    return String(name ?? '');
}

/**
 * Convert the value of a tool call to the type the state declares.
 *
 * @param {string|number|boolean} val value from the model
 * @param {string|undefined} type common.type of the state
 * @returns {string|number|boolean} converted value
 */
function coerce(val, type) {
    if (type === 'boolean') {
        return typeof val === 'string' ? val.toLowerCase() === 'true' : Boolean(val);
    }
    if (type === 'number') {
        const n = Number(val);
        if (Number.isNaN(n)) {
            throw new Error(`Value "${val}" is not a number`);
        }
        return n;
    }
    if (type === 'string') {
        return String(val);
    }
    return val;
}

const text = t => ({ output: [{ type: 'text', text: t }] });

/** At most this many allowed values of a state go to the model. */
const MAX_STATES = 30;

/**
 * What the model needs to know about a state: name, role, type, unit, writable, and where set min, max and the
 * allowed values (common.states, e.g. {"0": "Aus", "1": "Auto", "2": "Ein"}: the key is the value to write).
 *
 * @param {string} id state id
 * @param {{ name?: ioBroker.StringOrTranslated, role?: string, type?: string, unit?: string, write?: boolean, min?: number, max?: number, states?: unknown }} c common part of the state object
 * @returns {Record<string, unknown>} row for the model
 */
function stateRow(id, c) {
    const row = {
        id,
        name: nameText(c.name),
        role: c.role,
        type: c.type,
        unit: c.unit,
        write: c.write !== false,
    };
    if (typeof c.min === 'number') {
        row.min = c.min;
    }
    if (typeof c.max === 'number') {
        row.max = c.max;
    }
    if (c.states && typeof c.states === 'object' && !Array.isArray(c.states)) {
        row.states = Object.fromEntries(Object.entries(c.states).slice(0, MAX_STATES));
    } else if (typeof c.states === 'string' && c.states) {
        // the old form "0:Aus;1:Ein"
        row.states = c.states.split(';').slice(0, MAX_STATES).join(';');
    } else if (Array.isArray(c.states)) {
        row.states = c.states.slice(0, MAX_STATES);
    }
    return row;
}

/**
 * The answer of another adapter as text for the model, cut to MAX_ANSWER characters.
 *
 * @param {unknown} answer answer of sendTo
 * @returns {string} text
 */
function detailAnswer(answer) {
    const reply = typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
    return reply.length > MAX_ANSWER ? `${reply.slice(0, MAX_ANSWER)}… (cut)` : reply;
}

/**
 * One row of list_instances.
 *
 * @param {string} id instance object id, e.g. "system.adapter.web.0"
 * @param {Partial<ioBroker.InstanceCommon>} c common part of the instance object
 * @param {ioBroker.StateValue} alive value of <id>.alive, or null
 * @param {ioBroker.StateValue} connected value of <id>.connected, or null
 * @returns {object} row for the model
 */
function instanceRow(id, c, alive, connected) {
    return {
        instance: id.replace('system.adapter.', ''),
        title: nameText(c.titleLang || c.title),
        version: c.version,
        mode: c.mode,
        enabled: c.enabled === true,
        alive,
        connected,
    };
}

/**
 * Case-insensitive regular expression for a glob with "*".
 *
 * @param {string} glob pattern
 * @returns {RegExp} anchored expression
 */
function globToRegExp(glob) {
    const body = glob
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${body}$`, 'i');
}

/**
 * Short, single-line rendering of tool arguments for the log.
 *
 * @param {unknown} args tool arguments
 * @param {number} [max] maximum length
 * @returns {string} shortened JSON
 */
function shortArgs(args, max = 160) {
    const s = JSON.stringify(args ?? {});
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Instance name of a tool argument: "telegram.0" also from "system.adapter.telegram.0", lower case.
 *
 * @param {unknown} value argument of the model
 * @returns {string} instance, e.g. "telegram.0"
 */
function instanceOf(value) {
    return String(value ?? '')
        .trim()
        .replace(/^system\.adapter\./i, '')
        .toLowerCase();
}

/**
 * Build the ioBroker extension: tools, system prompt section and the write guard.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter running adapter
 * @param {object} rt loaded pi-durable runtime ({ Type, defineExtension, defineTool, defineTask, hook, section, ToolTask })
 * @param {() => import('./types').Policy} policy live policy and the adapter functions the tools call back into
 * @returns {object} extension for the registry
 */
function createIoBrokerExtension(adapter, rt, policy) {
    const { Type, defineExtension, defineTool, defineTask, hook, section, ToolTask } = rt;
    const logCall = (name, args, outcome) => adapter.log.info(`Tool ${name} ${shortArgs(args)} -> ${outcome}`);

    /**
     * State objects whose id (or name) matches a pattern. The object view is read from the literal prefix
     * of the pattern and filtered here, because a pattern starting with "*" finds nothing through
     * getForeignObjects on a real installation.
     *
     * @param {string} pattern glob with "*", or a plain word (then searched anywhere, case-insensitive)
     * @returns {Promise<Record<string, ioBroker.StateObject>>} matching objects by id
     */
    async function findStateObjects(pattern) {
        const glob = pattern.includes('*') ? pattern : `*${pattern}*`;
        const prefix = glob.slice(0, glob.indexOf('*'));
        const re = globToRegExp(glob);
        const view = await adapter.getObjectViewAsync('system', 'state', {
            startkey: prefix,
            endkey: `${prefix}${HIGHEST_KEY_CHAR}`,
        });
        const rows = (view?.rows || []).filter(
            ({ id, value }) => value && (re.test(id) || re.test(nameText(value.common?.name))),
        );
        return Object.fromEntries(rows.map(({ id, value }) => [id, value]));
    }

    const searchObjects = defineTool({
        name: 'search_objects',
        description: `Find ioBroker states by ID pattern or name, e.g. "hm-rpc.0.*", "*Licht*" or just "Licht" (case-insensitive, also matches the name). Returns at most ${MAX_RESULTS} entries with id, name, role, type, unit, whether it is writable, and min, max and the allowed values (states) where the state has them. For a room or a function (lights, heating) use find_states.`,
        parameters: Type.Object({ pattern: Type.String() }),
        replay: 'safe',
        execute: async args => {
            const objects = await findStateObjects(args.pattern);
            const ids = Object.keys(objects).sort();
            const rows = ids.slice(0, MAX_RESULTS).map(id => stateRow(id, objects[id].common));
            logCall(
                'search_objects',
                args,
                `${ids.length} objects${ids.length > rows.length ? `, ${rows.length} shown` : ''}`,
            );
            return text(JSON.stringify({ total: ids.length, shown: rows.length, rows }));
        },
    });

    const getState = defineTool({
        name: 'get_state',
        description: `Read the current value of one ioBroker state, or of all states matching a pattern with "*" (at most ${MAX_RESULTS}). A pattern only finds states that have an object; for adapter instances use list_instances.`,
        parameters: Type.Object({ id: Type.String() }),
        replay: 'safe',
        execute: async args => {
            if (args.id.includes('*')) {
                const found = Object.keys(await findStateObjects(args.id));
                const states = found.length ? (await adapter.getForeignStatesAsync(found)) || {} : {};
                const ids = found.filter(id => states[id]);
                const rows = ids
                    .slice(0, MAX_RESULTS)
                    .map(id => ({ id, val: states[id].val, ack: states[id].ack, ts: states[id].ts }));
                logCall(
                    'get_state',
                    args,
                    `${ids.length} states${ids.length > rows.length ? `, ${rows.length} shown` : ''}`,
                );
                return text(JSON.stringify({ total: ids.length, shown: rows.length, rows }));
            }
            const state = await adapter.getForeignStateAsync(args.id);
            if (!state) {
                logCall('get_state', args, 'no value');
                return text(`State ${args.id} does not exist or has no value.`);
            }
            // type, unit and the allowed values tell the model how to read the value and what it may write back;
            // they are extra: without the object the value still comes back
            const obj = await Promise.resolve()
                .then(() => adapter.getForeignObjectAsync(args.id))
                .catch(() => null);
            const {
                id: _id,
                name: _name,
                ...about
            } = obj?.common ? stateRow(args.id, obj.common) : { id: '', name: '' };
            logCall('get_state', args, `val=${shortArgs(state.val, 60)}`);
            return text(JSON.stringify({ val: state.val, ack: state.ack, ts: state.ts, lc: state.lc, ...about }));
        },
    });

    /**
     * Rooms or functions (enum.rooms.*, enum.functions.*) with their names in every language and their members.
     *
     * @param {string} kind "rooms" or "functions"
     * @returns {Promise<Array<{ id: string, name: string, names: string[], members: string[] }>>} enums
     */
    async function readEnums(kind) {
        const view = await adapter.getObjectViewAsync('system', 'enum', {
            startkey: `enum.${kind}.`,
            endkey: `enum.${kind}.${HIGHEST_KEY_CHAR}`,
        });
        return (view?.rows || [])
            .filter(({ value }) => value?.common)
            .map(({ id, value }) => {
                const name = value.common.name;
                const names = name && typeof name === 'object' ? Object.values(name).map(String) : [String(name ?? '')];
                return {
                    id,
                    name: nameText(name) || id.slice(`enum.${kind}.`.length),
                    names: [...names, id.slice(`enum.${kind}.`.length)].filter(Boolean),
                    members: Array.isArray(value.common.members) ? value.common.members.map(String) : [],
                };
            });
    }

    /**
     * The enums whose name (in any language) or id contains a word, case-insensitive.
     *
     * @param {string} kind "rooms" or "functions"
     * @param {string} word room or function as the user calls it, e.g. "Küche" or "kitchen"
     * @returns {Promise<Array<{ id: string, name: string, members: string[] }>>} matching enums
     */
    async function enumsNamed(kind, word) {
        const w = word.trim().toLowerCase();
        const all = await readEnums(kind);
        const exact = all.filter(e => e.names.some(n => n.toLowerCase() === w) || e.id.toLowerCase() === w);
        return exact.length ? exact : all.filter(e => e.names.some(n => n.toLowerCase().includes(w)));
    }

    /**
     * The states that belong to members of enums: a member is a state, or a device/channel with states below it.
     *
     * @param {string[]} members ids of the members
     * @returns {Promise<Record<string, ioBroker.StateObject>>} state objects by id
     */
    async function statesOfMembers(members) {
        const found = new Map();
        for (const member of new Set(members)) {
            const view = await adapter.getObjectViewAsync('system', 'state', {
                startkey: member,
                endkey: `${member}.${HIGHEST_KEY_CHAR}`,
            });
            for (const { id, value } of view?.rows || []) {
                if (value && (id === member || id.startsWith(`${member}.`))) {
                    found.set(id, value);
                }
            }
        }
        return Object.fromEntries(found);
    }

    const listEnum = kind =>
        defineTool({
            name: `list_${kind}`,
            description:
                kind === 'rooms'
                    ? 'List the rooms of the house as set up in ioBroker (enum.rooms), with their names and how many devices or states they have. Use find_states to get the states of a room.'
                    : 'List the functions of the house as set up in ioBroker (enum.functions), e.g. lights, heating, blinds, with their names and how many devices or states they have. Use find_states to get the states of a function.',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: async args => {
                const rows = (await readEnums(kind)).map(e => ({ id: e.id, name: e.name, members: e.members.length }));
                logCall(`list_${kind}`, args, `${rows.length} ${kind}`);
                return text(JSON.stringify({ total: rows.length, rows }));
            },
        });

    const findStates = defineTool({
        name: 'find_states',
        description: `The states of a room and/or a function as set up in ioBroker, e.g. room "Küche" with function "Licht" for "the lights in the kitchen". Names match in any language, also partly. Returns at most ${MAX_RESULTS} states with id, name, role, type, unit, writable, min, max and allowed values. Prefer it over search_objects for rooms and device groups.`,
        parameters: Type.Object({
            room: Type.Optional(Type.String()),
            function: Type.Optional(Type.String()),
        }),
        replay: 'safe',
        execute: async args => {
            if (!args.room && !args.function) {
                throw new Error('Give a room, a function, or both');
            }
            const parts = [];
            for (const [kind, word] of [
                ['rooms', args.room],
                ['functions', args.function],
            ]) {
                if (!word) {
                    continue;
                }
                const enums = await enumsNamed(kind, String(word));
                if (enums.length === 0) {
                    logCall('find_states', args, `no ${kind.slice(0, -1)} "${word}"`);
                    const known = (await readEnums(kind)).map(e => e.name);
                    return text(
                        JSON.stringify({ error: `No ${kind.slice(0, -1)} named "${word}"`, [`known ${kind}`]: known }),
                    );
                }
                parts.push({ enums, states: await statesOfMembers(enums.flatMap(e => e.members)) });
            }
            // room and function: only the states in both
            const ids = Object.keys(parts[0].states)
                .filter(id => parts.every(p => p.states[id]))
                .sort();
            const rows = ids.slice(0, MAX_RESULTS).map(id => stateRow(id, parts[0].states[id].common));
            logCall('find_states', args, `${ids.length} states`);
            return text(
                JSON.stringify({
                    matched: parts.flatMap(p => p.enums.map(e => e.id)),
                    total: ids.length,
                    shown: rows.length,
                    rows,
                }),
            );
        },
    });

    const listInstances = defineTool({
        name: 'list_instances',
        description:
            'List all adapter instances with title, version, mode, whether they are enabled, and their alive/connected state. Instances of mode "once" or "schedule" are not alive between runs; that is normal.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async args => {
            // Start from the instance objects and read alive/connected by exact id: a pattern query
            // misses a state whose object is gone (seen with vis.0 on a real installation).
            const view = await adapter.getObjectViewAsync('system', 'instance', {
                startkey: 'system.adapter.',
                endkey: `system.adapter.${HIGHEST_KEY_CHAR}`,
            });
            const rows = [];
            for (const { id, value } of view?.rows || []) {
                const [alive, connected] = await Promise.all([
                    adapter.getForeignStateAsync(`${id}.alive`),
                    adapter.getForeignStateAsync(`${id}.connected`),
                ]);
                rows.push(instanceRow(id, value?.common || {}, alive?.val ?? null, connected?.val ?? null));
            }
            const running = rows.filter(r => r.alive === true).length;
            logCall('list_instances', args, `${rows.length} instances, ${running} alive`);
            return text(JSON.stringify({ total: rows.length, running, rows }));
        },
    });

    const setState = defineTool({
        name: 'set_state',
        description:
            'Write a command (ack=false) to one ioBroker state. Only states on the write allowlist are accepted. After an interruption the call is NOT repeated: read the state again before trying once more.',
        parameters: Type.Object({
            id: Type.String(),
            val: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
        }),
        // No replay: "safe" - a half-done write must never run twice after a crash.
        execute: async args => {
            const obj = await adapter.getForeignObjectAsync(args.id);
            if (!obj || obj.type !== 'state') {
                logCall('set_state', args, 'refused: no such state');
                throw new Error(`State ${args.id} does not exist`);
            }
            if (obj.common?.write === false) {
                logCall('set_state', args, 'refused: read-only');
                throw new Error(`State ${args.id} is read-only`);
            }
            const val = coerce(args.val, obj.common?.type);
            if (policy().dryRun) {
                logCall('set_state', args, 'dry run, not written');
                return text(
                    `DRY RUN - NOTHING WAS WRITTEN. ${args.id} keeps its old value; it would have been set to ${JSON.stringify(val)}. Tell the user plainly that nothing was changed because dry run is on.`,
                );
            }
            await adapter.setForeignStateAsync(args.id, { val, ack: false });
            logCall('set_state', args, 'written');
            return text(`Command sent: ${args.id} = ${JSON.stringify(val)}`);
        },
    });

    const getHistory = defineTool({
        name: 'get_history',
        description:
            'Values of one state over the last hours from the history adapter (history, sql or influxdb), averaged to at most "points" values. Use it for trends, minimum/maximum and "how was it yesterday" questions.',
        parameters: Type.Object({
            id: Type.String(),
            hours: Type.Optional(Type.Number({ description: 'how far back, default 24, at most 744 (31 days)' })),
            points: Type.Optional(Type.Number({ description: 'number of values, default 50, at most 200' })),
        }),
        replay: 'safe',
        execute: async args => {
            const instance = await policy().historyInstance();
            if (!instance) {
                logCall('get_history', args, 'no history instance');
                throw new Error(
                    'No history instance: set one in the pi-agent settings or a default history in the system settings',
                );
            }
            const hours = Math.min(Math.max(Number(args.hours ?? 24), 0.1), 744);
            const points = Math.min(Math.max(Math.round(Number(args.points ?? 50)), 2), 200);
            const end = Date.now();
            const start = end - hours * 3600_000;
            const reply = await adapter.sendToAsync(
                instance,
                'getHistory',
                { id: args.id, options: { start, end, aggregate: 'average', count: points, ignoreNull: true } },
                { timeout: 30_000 },
            );
            // the answer of another adapter is untyped; Object() reads its fields safely
            const { error, result } = Object(reply);
            if (error) {
                logCall('get_history', args, `error from ${instance}`);
                throw new Error(`${instance}: ${error}`);
            }
            const zone = policy().timeZone || 'UTC';
            const rows = (Array.isArray(result) ? result : []).map(r => ({
                time: formatLocal(r.ts, zone, { zone: false }),
                val: r.val,
            }));
            logCall('get_history', args, `${rows.length} values from ${instance}`);
            return text(
                JSON.stringify({
                    instance,
                    timeZone: zone,
                    from: formatLocal(start, zone, { zone: false }),
                    to: formatLocal(end, zone, { zone: false }),
                    rows,
                }),
            );
        },
    });

    // A reminder sleeps in the conversation store until it is due, so it survives restarts of the adapter.
    const Reminder = defineTask({
        name: 'iobroker.reminder',
        version: 1,
        initial: () => ({ phase: 'wait' }),
        phases: {
            wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: 'deliver' }, context),
            deliver: async (task, runtime, context) => {
                await policy().deliverReminder(task.input.conversationId, task.input.text);
                await runtime.commit(
                    () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
                    context,
                );
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });

    const remindMe = defineTool({
        name: 'remind_me',
        description:
            'Send the user a reminder later, in this conversation (messenger chat, or chat.answer). Give either "minutes" from now, or "at" as local time of the house: "18:00" (today, or tomorrow when past), "2026-10-27 18:00" or "27.10. 18:00". At most 7 days ahead. Survives restarts.',
        parameters: Type.Object({
            text: Type.String(),
            minutes: Type.Optional(Type.Number()),
            at: Type.Optional(Type.String()),
        }),
        // No replay: "safe" - a rerun after a crash must not create the reminder twice.
        execute: async (args, api, context) => {
            const { at, zone } = whenOf(args, 'remind_me');
            await api.createTask(
                Reminder,
                { at, text: args.text, conversationId: api.conversationId },
                { ownership: { kind: 'conversation' }, background: true },
                context,
            );
            const when = formatLocal(at, zone);
            logCall('remind_me', args, `set for ${when}`);
            return text(`Reminder set for ${when}. Tell the user this local time.`);
        },
    });

    /**
     * The time of a scheduled action: "minutes" from now, or "at" as local time of the house; at most 7 days ahead.
     *
     * @param {{ minutes?: number, at?: string }} args arguments of the tool
     * @param {string} name tool name for the log
     * @returns {{ at: number, zone: string }} instant and time zone
     */
    function whenOf(args, name) {
        const now = Date.now();
        const zone = policy().timeZone || 'UTC';
        const at =
            args.minutes !== undefined ? now + Number(args.minutes) * 60_000 : parseLocalTime(args.at, zone, now);
        if (!Number.isFinite(at) || at < now + 5_000 || at > now + 7 * 24 * 3600_000) {
            logCall(name, args, 'refused: time not within 7 days');
            throw new Error('The time must be in the future and at most 7 days ahead');
        }
        return { at, zone };
    }

    // A scheduled write sleeps in the conversation store like a reminder. When it is due the write permission is
    // checked again, so a permission taken away in the meantime stops it; the user hears what happened.
    const ScheduledWrite = defineTask({
        name: 'iobroker.write',
        version: 1,
        initial: () => ({ phase: 'wait' }),
        phases: {
            wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: 'write' }, context),
            write: async (task, runtime, context) => {
                const { id, val, conversationId } = task.input;
                let message;
                if (!isWriteAllowed(id, policy().allowlist)) {
                    message = `⏰ ${id} was not set to ${JSON.stringify(val)}: writing it is no longer allowed.`;
                    adapter.log.warn(`Scheduled write ${id} -> blocked: not on the write allowlist any more`);
                } else if (policy().dryRun) {
                    message = `⏰ Simulation mode: ${id} would now have been set to ${JSON.stringify(val)}.`;
                    adapter.log.info(`Scheduled write ${id} -> dry run, not written`);
                } else {
                    try {
                        await adapter.setForeignStateAsync(id, { val, ack: false });
                        message = `⏰ Done: ${id} set to ${JSON.stringify(val)}.`;
                        adapter.log.info(`Scheduled write ${id} = ${JSON.stringify(val)} -> written`);
                    } catch (e) {
                        message = `⏰ ${id} could not be set to ${JSON.stringify(val)}: ${e.message}`;
                        adapter.log.warn(`Scheduled write ${id} failed: ${e.message}`);
                    }
                }
                // the outcome is committed before it is told, so a crash in between does not write twice
                await runtime.commit(
                    () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
                    context,
                );
                await policy().deliverReminder(conversationId, message);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    });

    const scheduleSetState = defineTool({
        name: 'schedule_set_state',
        description:
            'Write a command to a state later, e.g. switch the heater off at 23:00. Give "minutes" from now, or "at" as local time of the house ("23:00", "2026-10-27 23:00", "27.10. 23:00"); at most 7 days ahead. The same write permissions as set_state; a confirmation is asked now, not when it is due. The user gets a message in this chat when it is done. Survives restarts.',
        parameters: Type.Object({
            id: Type.String(),
            val: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
            minutes: Type.Optional(Type.Number()),
            at: Type.Optional(Type.String()),
        }),
        // No replay: "safe" - a rerun after a crash must not schedule the write twice.
        execute: async (args, api, context) => {
            const obj = await adapter.getForeignObjectAsync(args.id);
            if (!obj || obj.type !== 'state' || obj.common?.write === false) {
                logCall('schedule_set_state', args, 'refused: no writable state');
                throw new Error(`State ${args.id} does not exist or is read-only`);
            }
            const val = coerce(args.val, obj.common?.type);
            const { at, zone } = whenOf(args, 'schedule_set_state');
            await api.createTask(
                ScheduledWrite,
                { at, id: args.id, val, conversationId: api.conversationId },
                { ownership: { kind: 'conversation' }, background: true },
                context,
            );
            const when = formatLocal(at, zone);
            logCall('schedule_set_state', args, `planned for ${when}`);
            return text(
                `Planned: ${args.id} = ${JSON.stringify(val)} at ${when}. Tell the user this local time; it can be cancelled with cancel_scheduled.`,
            );
        },
    });

    const notifyWhen = defineTool({
        name: 'notify_when',
        description:
            'Tell the user in this chat when a state meets a condition, e.g. "the washing machine is done" (power < 5 for 3 minutes) or "the window is open for more than 10 minutes" (== true for 10 minutes). condition: == != > < >= <= or "changes" (any new value). "minutes" (optional): the condition must hold that long. Only values reported by the device count. Fires once; ends after 7 days at the latest; at most 20 at a time.',
        parameters: Type.Object({
            id: Type.String(),
            condition: Type.String(),
            value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
            minutes: Type.Optional(Type.Number()),
            text: Type.String({ description: 'the message for the user, e.g. "The washing machine is done"' }),
        }),
        // No replay: "safe" - a rerun after a crash must not add the watch twice.
        execute: async (args, api) => {
            const obj = await adapter.getForeignObjectAsync(args.id);
            if (!obj || obj.type !== 'state') {
                logCall('notify_when', args, 'refused: no such state');
                throw new Error(`State ${args.id} does not exist`);
            }
            const result = await policy().watches.add({
                conversationId: api.conversationId,
                stateId: args.id,
                condition: String(args.condition).trim(),
                value: args.value,
                minutes: args.minutes,
                text: args.text,
            });
            logCall('notify_when', args, result.split(':')[0]);
            return text(result);
        },
    });

    const listScheduled = defineTool({
        name: 'list_scheduled',
        description:
            'List what is planned in this conversation: reminders (remind_me), scheduled writes (schedule_set_state) and watches (notify_when), each with its id for cancel_scheduled.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async (args, api) => {
            const zone = policy().timeZone || 'UTC';
            const rows = (await policy().scheduled.tasks(api.conversationId)).map(t => ({
                ...t,
                at: formatLocal(t.at, zone),
            }));
            const watches = policy()
                .watches.list(api.conversationId)
                .map(w => ({
                    id: w.id,
                    kind: 'watch',
                    state: w.stateId,
                    condition: w.condition === 'changes' ? 'changes' : `${w.condition} ${JSON.stringify(w.value)}`,
                    minutes: w.forMs ? Math.round(w.forMs / 60_000) : undefined,
                    text: w.text,
                    until: formatLocal(w.until, zone),
                }));
            logCall('list_scheduled', args, `${rows.length} planned, ${watches.length} watches`);
            return text(JSON.stringify({ planned: rows, watches }));
        },
    });

    const cancelScheduled = defineTool({
        name: 'cancel_scheduled',
        description:
            'Cancel a reminder, a scheduled write or a watch of this conversation by its id from list_scheduled.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (args, api) => {
            const id = String(args.id).trim();
            const done = id.startsWith('w')
                ? await policy().watches.cancel(api.conversationId, id)
                : await policy().scheduled.cancel(api.conversationId, id);
            logCall('cancel_scheduled', args, done ? 'cancelled' : 'not found');
            return text(done ? `Cancelled ${id}.` : `Nothing with id ${id} is planned in this conversation.`);
        },
    });

    const getLogs = defineTool({
        name: 'get_logs',
        description:
            'The newest lines of the ioBroker log, to find out why something does not work: optional "instance" (e.g. "zigbee.0", or an adapter name like "zigbee"), "level" (lowest level: error, warn (default), info, debug), "search" (a word in the message) and "count" (default 30, at most 50).',
        parameters: Type.Object({
            instance: Type.Optional(Type.String()),
            level: Type.Optional(Type.String()),
            search: Type.Optional(Type.String()),
            count: Type.Optional(Type.Number()),
        }),
        replay: 'safe',
        execute: async args => {
            const file = policy().logFile?.();
            if (!file) {
                logCall('get_logs', args, 'no log file');
                throw new Error('The log file of ioBroker was not found next to iobroker-data');
            }
            const lines = readLog(file, args);
            logCall('get_logs', args, `${lines.length} lines`);
            return text(JSON.stringify({ file: path.basename(file), lines }));
        },
    });

    const listNotifications = defineTool({
        name: 'list_notifications',
        description:
            'The notifications of ioBroker (the bell in admin): problems and news that adapters and js-controller reported, with category, instance and message.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async args => {
            const view = await adapter.getObjectViewAsync('system', 'state', {
                startkey: 'system.host.',
                endkey: `system.host.${HIGHEST_KEY_CHAR}`,
            });
            const ids = (view?.rows || [])
                .map(r => r.id)
                .filter(id => /^system\.host\.[^.]+\.notifications\./.test(id));
            const states = ids.length ? (await adapter.getForeignStatesAsync(ids)) || {} : {};
            const rows = [];
            for (const id of ids) {
                let value = states[id]?.val;
                try {
                    value = typeof value === 'string' ? JSON.parse(value) : value;
                } catch {
                    continue;
                }
                rows.push(...flattenNotifications(id.split('.notifications.')[1], value));
            }
            logCall('list_notifications', args, `${rows.length} notifications`);
            return text(JSON.stringify({ total: rows.length, rows: rows.slice(0, MAX_RESULTS) }));
        },
    });

    const getTime = defineTool({
        name: 'get_time',
        description:
            'Current local date, time and weekday in the time zone of the house. Use it before you work with "today", "tomorrow", "in two hours" or a clock time.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async args => {
            const zone = policy().timeZone || 'UTC';
            const now = Date.now();
            const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(new Date(now));
            const local = formatLocal(now, zone);
            logCall('get_time', args, local);
            return text(JSON.stringify({ now: local, weekday, timeZone: zone }));
        },
    });

    /**
     * The guard of restart_instance: only instances with "Restart allowed", and every restart confirmed by the user
     * in the chat of the conversation (also without "Confirmation required"). Simulation mode needs no confirmation.
     *
     * @param {{ arguments?: Record<string, unknown> }} call the tool call
     * @param {{ memo: (key: string, ...rest: unknown[]) => Promise<unknown>, conversationId: unknown }} api tool api
     * @param {unknown} context durable context
     * @returns {Promise<{ block: string } | undefined>} a block, or undefined to run the call
     */
    async function guardRestart(call, api, context) {
        const instance = instanceOf(call.arguments?.instance);
        if (!(policy().restartList || []).includes(instance)) {
            adapter.log.warn(`Tool restart_instance ${shortArgs(call.arguments)} -> blocked: restart not allowed`);
            return {
                block: `Restarting ${instance} is not allowed: it needs "Restart allowed" in the write permissions of the pi-agent settings (pi-agent and admin are never restarted). Tell the user instead of retrying.`,
            };
        }
        if (policy().dryRun) {
            return undefined;
        }
        // The decision is stored with the call: after a restart of pi-agent the user is not asked a second time.
        let decision = await api.memo('confirmation', context);
        if (decision === undefined) {
            const answer = await policy().requestConfirmation({
                conversationId: api.conversationId,
                id: instance,
                val: null,
                action: 'restart',
            });
            decision = await api.memo('confirmation', answer, context);
        }
        adapter.log.info(`Tool restart_instance ${shortArgs(call.arguments)} -> confirmation: ${decision}`);
        if (decision !== 'yes') {
            return {
                block: `The user did not confirm restarting ${instance} (${decision}). Tell the user; do not retry unless asked again.`,
            };
        }
        return undefined;
    }

    /**
     * The guard of send_to: only to a whole instance with "Write allowed" (never pi-agent or admin), confirmed by the
     * user where "Confirmation required" is set for it. Simulation mode needs no confirmation.
     *
     * @param {{ arguments?: Record<string, unknown> }} call the tool call
     * @param {{ memo: (key: string, ...rest: unknown[]) => Promise<unknown>, conversationId: unknown }} api tool api
     * @param {unknown} context durable context
     * @returns {Promise<{ block: string } | undefined>} a block, or undefined to run the call
     */
    async function guardSendTo(call, api, context) {
        const instance = instanceOf(call.arguments?.instance);
        const command = String(call.arguments?.command ?? '');
        if (!isRestartable(instance) || !isWriteAllowed(instance, policy().allowlist)) {
            adapter.log.warn(`Tool send_to ${shortArgs(call.arguments)} -> blocked: not allowed`);
            return {
                block: `Sending commands to ${instance} is not allowed: it needs "Write allowed" for the instance ${instance} in the write permissions of the pi-agent settings (never pi-agent or admin). Tell the user instead of retrying.`,
            };
        }
        if (policy().dryRun || !isWriteAllowed(instance, policy().confirmList || [])) {
            return undefined;
        }
        // The decision is stored with the call: after a restart of pi-agent the user is not asked a second time.
        let decision = await api.memo('confirmation', context);
        if (decision === undefined) {
            const answer = await policy().requestConfirmation({
                conversationId: api.conversationId,
                id: instance,
                val: command,
                action: 'sendTo',
            });
            decision = await api.memo('confirmation', answer, context);
        }
        adapter.log.info(`Tool send_to ${shortArgs(call.arguments)} -> confirmation: ${decision}`);
        if (decision !== 'yes') {
            return {
                block: `The user did not confirm the command "${command}" to ${instance} (${decision}). Tell the user; do not retry unless asked again.`,
            };
        }
        return undefined;
    }

    const sendToTool = defineTool({
        name: 'send_to',
        description:
            'Send a command to another adapter instance and return its answer, e.g. instance "telegram.0", command "send", message {"text": "Hello"}. Use the command and message the adapter documents. Only instances with "Write allowed" in the write permissions; some need the confirmation of the user. Never pi-agent or admin. After an interruption the command is NOT repeated.',
        parameters: Type.Object({
            instance: Type.String(),
            command: Type.String(),
            message: Type.Optional(Type.Unknown()),
        }),
        // No replay: "safe" - a command may act in the world and must never be sent twice after a crash.
        execute: async args => {
            const instance = instanceOf(args.instance);
            if (policy().dryRun) {
                logCall('send_to', args, 'dry run, not sent');
                return text(
                    `DRY RUN - NOTHING WAS SENT. ${instance} would have received the command "${args.command}". Tell the user plainly that nothing was sent because the simulation mode is on.`,
                );
            }
            let answer;
            try {
                answer = await adapter.sendToAsync(instance, String(args.command), args.message ?? {}, {
                    timeout: SEND_TO_TIMEOUT_MS,
                });
            } catch (e) {
                logCall('send_to', args, `no answer: ${e.message}`);
                return text(
                    `The command "${args.command}" was sent to ${instance}, but there was no answer within ${SEND_TO_TIMEOUT_MS / 1000} s (${e.message}). Many adapters do not answer; the command may still have worked. Do not send it again on your own.`,
                );
            }
            const reply = detailAnswer(answer);
            logCall('send_to', args, 'sent');
            return text(`Sent. Answer of ${instance}: ${reply}`);
        },
    });

    const restartInstance = defineTool({
        name: 'restart_instance',
        description:
            'Restart one adapter instance, e.g. "telegram.0" or "hm-rpc.0" (from list_instances). Only instances with "Restart allowed" in the write permissions; the user confirms every restart. Never pi-agent or admin. Waits until the instance runs again.',
        parameters: Type.Object({ instance: Type.String() }),
        // No replay: "safe" - an interrupted restart is not repeated on its own after a crash.
        execute: async args => {
            const instance = instanceOf(args.instance);
            if (policy().dryRun) {
                logCall('restart_instance', args, 'dry run, not restarted');
                return text(
                    `DRY RUN - NOTHING WAS RESTARTED. ${instance} would have been restarted. Tell the user plainly that nothing was restarted because the simulation mode is on.`,
                );
            }
            const result = await policy().restartInstance(instance);
            logCall('restart_instance', args, result);
            return text(result);
        },
    });

    const remember = defineTool({
        name: 'remember',
        description:
            'Keep a fact in the long-term memory, shared by all conversations of the agent (messengers, admin chat, voice assistant): a preference, a name of a device, a habit. One short fact per call. Never passwords, keys or other secrets.',
        parameters: Type.Object({ fact: Type.String() }),
        execute: async args => {
            const result = await policy().memory.add(String(args.fact ?? ''));
            logCall('remember', args, result.split('.')[0]);
            return text(result);
        },
    });

    const forget = defineTool({
        name: 'forget',
        description:
            'Remove facts from the long-term memory: give the id of a fact (as listed in the instructions, e.g. "m3") or a word that only the facts to remove contain.',
        parameters: Type.Object({ fact: Type.String() }),
        execute: async args => {
            const result = await policy().memory.remove(String(args.fact ?? ''));
            logCall('forget', args, result.split('.')[0]);
            return text(result);
        },
    });

    /** The long-term memory as a block of the instructions, or "" when it is off or empty. */
    const memoryText = () => {
        const memory = policy().memory;
        if (!memory) {
            return '';
        }
        if (!memory.enabled()) {
            return 'The long-term memory is switched off in the settings: do not call remember or forget.';
        }
        const facts = memory.list();
        const rules =
            'When the user asks you to remember something, or tells you a lasting fact about the house or a preference, call remember. When asked to forget something, call forget. Never keep passwords, keys or other secrets.';
        if (facts.length === 0) {
            return `Long-term memory: empty. ${rules}`;
        }
        return [
            `Long-term memory (facts kept across all conversations; the user may correct them). ${rules}`,
            ...facts.map(f => `- [${f.id}] ${f.text}`),
        ].join('\n');
    };

    return defineExtension({
        name: 'iobroker',
        sections: [
            section(
                'iobroker',
                () =>
                    [
                        'You control an ioBroker smart home through tools.',
                        'Always look up state IDs instead of guessing them: find_states for a room or a function ("the lights in the kitchen"; list_rooms and list_functions show what exists), search_objects for anything else.',
                        'Where a state lists allowed values (states), write the key of the value meant, e.g. 2 for {"2": "Ein"}; keep within min and max.',
                        'To read many values at once, call get_state with a "*" pattern. For questions about adapters or instances use list_instances.',
                        'Read the current value before you change it. Only write what the user asked for.',
                        'If a write was reported as interrupted, read the state first: the command may already have worked.',
                        'Never claim that something was switched or changed unless set_state answered "Command sent".',
                        'The write permissions and the simulation mode are set in the instance settings of the pi-agent adapter (tab "Write permissions"); refer the user there when a write is blocked.',
                        'Some writes need the confirmation of the user (buttons in the messenger chat). If a write was not confirmed, say so and do not retry on your own.',
                        'For past values, trends, minimum or maximum use get_history. To remind the user later use remind_me; to write later use schedule_set_state; to tell the user when something happens use notify_when. list_scheduled and cancel_scheduled show and cancel them.',
                        'Times are local times of the house; call get_time when you need the current date or time.',
                        'When something does not work, look at get_logs (errors and warnings of an instance) and list_notifications before you restart anything.',
                        'To restart an adapter instance use restart_instance; it needs "Restart allowed" in the write permissions and the confirmation of the user.',
                        'For a command to another adapter (e.g. send a Telegram message, speak a text) use send_to with the command and message that adapter documents; it needs "Write allowed" for that instance in the write permissions.',
                        "Answer in the language of the user's last message, unless the instructions below (of the user or of the calling adapter) name a language: then answer in that language.",
                        memoryText(),
                        policy().instructions,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                { tag: false },
            ),
        ],
        tools: [
            searchObjects,
            getState,
            listEnum('rooms'),
            listEnum('functions'),
            findStates,
            listInstances,
            getHistory,
            setState,
            remindMe,
            scheduleSetState,
            notifyWhen,
            listScheduled,
            cancelScheduled,
            getLogs,
            listNotifications,
            getTime,
            restartInstance,
            sendToTool,
            remember,
            forget,
        ],
        tasks: [Reminder, ScheduledWrite],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if (call.name === 'restart_instance') {
                        return guardRestart(call, api, context);
                    }
                    if (call.name === 'send_to') {
                        return guardSendTo(call, api, context);
                    }
                    // a scheduled write is checked (and confirmed) like a write now
                    if (call.name !== 'set_state' && call.name !== 'schedule_set_state') {
                        return undefined;
                    }
                    const id = String(call.arguments?.id ?? '');
                    if (!isWriteAllowed(id, policy().allowlist)) {
                        adapter.log.warn(
                            `Tool ${call.name} ${shortArgs(call.arguments)} -> blocked: not on the write allowlist`,
                        );
                        return {
                            block: `State ${id} is not on the write allowlist. Tell the user instead of retrying.`,
                        };
                    }
                    // Confirmation by the user (buttons in the messenger chat). In dry run nothing is written, so nothing to confirm.
                    if (policy().dryRun || !isWriteAllowed(id, policy().confirmList || [])) {
                        return undefined;
                    }
                    // The decision is stored with the call: after a restart the user is not asked a second time.
                    let decision = await api.memo('confirmation', context);
                    if (decision === undefined) {
                        const answer = await policy().requestConfirmation({
                            conversationId: api.conversationId,
                            id,
                            val: call.arguments?.val,
                        });
                        decision = await api.memo('confirmation', answer, context);
                    }
                    adapter.log.info(`Tool ${call.name} ${shortArgs(call.arguments)} -> confirmation: ${decision}`);
                    if (decision !== 'yes') {
                        return {
                            block: `The user did not confirm writing ${id} (${decision}). Tell the user; do not retry unless asked again.`,
                        };
                    }
                    return undefined;
                },
            }),
        ],
    });
}

module.exports = { createIoBrokerExtension, nameText, coerce };
