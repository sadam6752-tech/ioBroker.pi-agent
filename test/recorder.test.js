'use strict';

// 0.11.0: the tools of ioBroker.recorder (house_events, house_snapshot, house_anomalies, usual_value) and get_history
// with the recorder as a second source: the pure parts of lib/recorder.js, and the tools through the real main.js
// with a fake recorder instance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');
const recorder = require('../lib/recorder');
const { parseLocalTime } = require('../lib/time');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-recorder-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const ZONE = 'Europe/Berlin';
const TG = 'telegram.0';
const USERS = JSON.stringify({ 1: { firstName: 'Alex', userName: 'alex' } });
const TELEGRAM = { messengers: [{ enabled: true, instance: TG, users: '1', prefix: '' }], timeZone: ZONE };
const RECORDER = {
    objects: {
        'system.adapter.recorder.0': { type: 'instance', common: { name: 'recorder', enabled: true } },
        'enum.rooms.kitchen': {
            type: 'enum',
            common: { name: { en: 'Kitchen', de: 'Küche' }, members: ['hm.0.light'] },
        },
    },
};

async function receive(agent, db, messageId, text) {
    const ts = Date.now();
    db.setState(`${TG}.communicate.requestChatId`, { val: 100, ack: true, ts });
    db.setState(`${TG}.communicate.requestUserId`, { val: 1, ack: true, ts });
    db.setState(`${TG}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    db.setState(`${TG}.communicate.users`, { val: USERS, ack: true, ts });
    await agent.onStateChange(`${TG}.communicate.request`, { val: `[Alex]${text}`, ack: true, ts });
}

test('pastTime: a clock time or a date without a year is the last one, not the next one', () => {
    const now = parseLocalTime('2026-11-18 08:00', ZONE);
    const at = text => recorder.pastTime(text, ZONE, now);
    assert.equal(at('22:00'), parseLocalTime('2026-11-17 22:00', ZONE));
    assert.equal(at('07:30'), parseLocalTime('2026-11-18 07:30', ZONE));
    assert.equal(at('17.11. 22:00'), parseLocalTime('2026-11-17 22:00', ZONE));
    assert.equal(at('24.12. 18:00'), parseLocalTime('2025-12-24 18:00', ZONE), 'Christmas: last year');
    assert.equal(at('2026-11-17 03:00'), parseLocalTime('2026-11-17 03:00', ZONE));
    assert.equal(at(''), now);
    assert.equal(at('1794950000'), 1794950000000, 'seconds');
    assert.ok(Number.isNaN(at('yesterday')));
});

test('rows: value with text or unit, who with user and sender, anomaly state', () => {
    const e = recorder.eventRow(
        {
            ts: parseLocalTime('2026-11-17 21:05', ZONE),
            id: 'hm.0.light',
            name: 'Light',
            room: 'Küche',
            val: true,
            text: 'on',
            src: 'user',
            user: 'system.user.admin',
            from: 'system.adapter.admin.0',
        },
        ZONE,
    );
    assert.deepEqual(e, {
        time: '2026-11-17 21:05',
        name: 'Light',
        room: 'Küche',
        value: 'on',
        who: 'user (admin, admin.0)',
        id: 'hm.0.light',
    });
    assert.equal(recorder.valueOf({ val: 21.5, unit: '°C' }), '21.5 °C');
    assert.equal(recorder.valueOf({ val: false }), false);
    const s = recorder.snapshotRow({ id: 'x.0.t', name: null, room: null, val: 20, unit: '°C', lc: null }, ZONE);
    assert.deepEqual(s, { name: 'x.0.t', value: '20 °C', id: 'x.0.t' }, 'no change after the keyframe: no time');
    const a = recorder.anomalyRow(
        {
            ts: parseLocalTime('2026-11-18 03:10', ZONE),
            rule: 'rare',
            text: 'Front door at 3 am',
            oid: 'd.0',
            endTs: null,
        },
        ZONE,
    );
    assert.equal(a.state, 'open');
    assert.equal(a.time, '2026-11-18 03:10');
});

test('hourOfWeek: Monday 0:00 is 0, in the time zone of the house', () => {
    assert.equal(recorder.hourOfWeek(parseLocalTime('2026-11-16 00:30', ZONE), ZONE), 0, 'Monday');
    assert.equal(recorder.hourOfWeek(parseLocalTime('2026-11-17 22:15', ZONE), ZONE), 24 + 22, 'Tuesday 22:00');
    assert.equal(recorder.hourOfWeek(parseLocalTime('2026-11-22 23:59', ZONE), ZONE), 167, 'Sunday 23:00');
    assert.equal(recorder.hourLabel(46), 'Tue 22:00-23:00');
    const rows = recorder.profileAround(
        { profile: [{ how: 46, n: 6, mean: 21.234, sd: 0.4, min: 20.5, max: 22, pActive: 0, avgChanges: 3 }] },
        46,
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], {
        hour: 'Tue 22:00-23:00',
        asked: true,
        weeks: 6,
        mean: 21.23,
        deviation: 0.4,
        min: 20.5,
        max: 22,
        activeShare: 0,
    });
    assert.deepEqual(rows[0], { hour: 'Tue 21:00-22:00', weeks: 0 }, 'an hour without data');
    assert.equal(recorder.profileAround({ profile: [] }, 0)[0].hour, 'Sun 23:00-00:00', 'wraps around the week');
});

test('house_events: the tools exist with a recorder, the room is found in any language', async () => {
    const f = await faux();
    let seen = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        seed: RECORDER,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('house_events', { hours: 3, room: 'kitchen', who: 'user' }), {
                stopReason: 'toolUse',
            }),
            context => {
                seen = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('At 21:05 you switched the kitchen light on.');
            },
        ],
        hooks: {
            sendToAsync: (to, command) =>
                to === 'recorder.0' && command === 'getEvents'
                    ? {
                          events: [
                              {
                                  ts: Date.now() - 3600_000,
                                  id: 'hm.0.light',
                                  name: 'Kitchen light',
                                  room: 'Küche',
                                  val: true,
                                  text: 'on',
                                  src: 'user',
                                  user: 'system.user.admin',
                              },
                          ],
                          more: false,
                          ms: 3,
                      }
                    : undefined,
        },
    });
    await receive(agent, db, 1, 'what was switched in the kitchen?');
    await waitFor(() => seen, 'the answer');
    const [instance, command, request] = agent.asked.find(([, c]) => c === 'getEvents');
    assert.equal(`${instance}/${command}`, 'recorder.0/getEvents');
    assert.deepEqual(request.room.sort(), ['Kitchen', 'Küche', 'kitchen'].sort());
    assert.equal(request.src, 'user');
    assert.equal(request.newest, true);
    assert.ok(Math.abs(request.end - request.start - 3 * 3600_000) < 1000);
    assert.match(seen, /Kitchen light/);
    assert.match(seen, /user \(admin\)/);
    await stopAgent(agent);
});

test('no recorder instance: no recorder tools; get_history asks the recorder when the history has nothing', async () => {
    const f = await faux();
    let first = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('house_events', { hours: 3 }), { stopReason: 'toolUse' }),
            context => {
                first = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('ok');
            },
        ],
        hooks: { sendToAsync: () => ({ events: [{ ts: 1, id: 'a.0.b', name: 'Leak', val: 1 }] }) },
    });
    await receive(agent, db, 1, 'what happened?');
    await waitFor(() => first, 'the answer');
    assert.ok(!(agent.asked || []).some(([to]) => String(to).startsWith('recorder.')), 'nothing asked');
    assert.doesNotMatch(first, /Leak/);
    await stopAgent(agent);

    let seen = '';
    const second = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        seed: {
            objects: {
                ...RECORDER.objects,
                'system.config': { type: 'config', common: { defaultHistory: 'history.0' } },
            },
        },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_history', { id: 'x.0.temp', hours: 2, points: 3 }), {
                stopReason: 'toolUse',
            }),
            context => {
                seen = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('Warm.');
            },
        ],
        hooks: {
            sendToAsync: to =>
                to === 'history.0'
                    ? { result: [] }
                    : to === 'recorder.0'
                      ? { result: [{ val: 22.5, ts: Date.now() }] }
                      : undefined,
        },
    });
    await receive(second.agent, second.db, 2, 'how warm was it?');
    await waitFor(() => seen, 'the answer');
    assert.deepEqual(
        second.agent.asked.filter(([, c]) => c === 'getHistory').map(([to]) => to),
        ['history.0', 'recorder.0'],
    );
    assert.match(seen, /22\.5/);
    assert.match(seen, /recorder\.0/);
    await stopAgent(second.agent);
});

test('house_snapshot and an error of the recorder', async () => {
    const f = await faux();
    let seen = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        seed: RECORDER,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('house_snapshot', { at: '22:00', category: 'windowsDoors' }), {
                stopReason: 'toolUse',
            }),
            context => {
                seen = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('Closed.');
            },
        ],
        hooks: {
            sendToAsync: (to, command) =>
                command === 'getSnapshot' ? { error: 'The instance is not ready yet' } : undefined,
        },
    });
    await receive(agent, db, 1, 'was the window open at 22:00?');
    await waitFor(() => seen, 'the answer');
    const [, , request] = agent.asked.find(([, c]) => c === 'getSnapshot');
    assert.equal(request.category, 'windowsDoors');
    assert.ok(request.ts < Date.now(), 'the last 22:00, not the next one');
    assert.match(seen, /recorder\.0: The instance is not ready yet/);
    await stopAgent(agent);
});

test('house_snapshot before the recording: the answer says when the recording starts', async () => {
    const f = await faux();
    let seen = '';
    const first = parseLocalTime('2026-11-18 10:22', ZONE);
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        seed: RECORDER,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('house_snapshot', { at: '2026-11-18 10:15', room: 'kitchen' }), {
                stopReason: 'toolUse',
            }),
            context => {
                seen = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('The recording started later.');
            },
        ],
        hooks: {
            sendToAsync: (to, command) =>
                command === 'getSnapshot'
                    ? { ts: 1, keyframe: null, states: [], ms: 1 }
                    : command === 'getTimeline'
                      ? { start: 0, end: 1, step: 1, counts: [0], first, ms: 1 }
                      : undefined,
        },
    });
    await receive(agent, db, 1, 'how warm was the kitchen at 10:15?');
    await waitFor(() => seen, 'the answer');
    assert.match(seen, /the recording starts 2026-11-18 10:22/);
    await stopAgent(agent);
});

test('a recorder installed or removed while the agent runs restarts it; a change of its settings does not', async () => {
    const { agent, db } = await startAgent({ dataDir: tmp(), config: TELEGRAM, responses: [] });
    agent.recorderCheckMs = 5;
    assert.equal(agent.recorderInstance, '');
    db.objects['system.adapter.recorder.0'] = { type: 'instance', common: { name: 'recorder', enabled: true } };
    agent.onObjectChange('system.adapter.recorder.0', db.objects['system.adapter.recorder.0']);
    await waitFor(async () => agent.restarted === 1, 'the restart');
    assert.ok(agent.logs.some(([, m]) => /recorder\.0 is there now/.test(m)));

    agent.recorderInstance = 'recorder.0'; // as after the restart
    agent.onObjectChange('system.adapter.recorder.0', db.objects['system.adapter.recorder.0']); // settings saved
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(agent.restarted, 1);

    db.objects['system.adapter.recorder.0'].common.enabled = false;
    agent.onObjectChange('system.adapter.recorder.0', db.objects['system.adapter.recorder.0']);
    await waitFor(async () => agent.restarted === 2, 'the restart without the recorder');
    await stopAgent(agent);
});
