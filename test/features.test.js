'use strict';

// Confirmation of writes in Telegram, reminders, history and usage - through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-feat-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const TG = 'telegram.0';
const USERS = JSON.stringify({ 1: { firstName: 'Alex', userName: 'alex' } });
const TELEGRAM = { messengers: [{ enabled: true, instance: TG, users: '1', prefix: '' }] };
const WRITE = { writeAllow: '^x\\.0\\.', confirmRequired: '^x\\.0\\.', dryRun: false };

async function receive(agent, db, messageId, text) {
    const ts = Date.now();
    db.setState(`${TG}.communicate.requestChatId`, { val: 100, ack: true, ts });
    db.setState(`${TG}.communicate.requestUserId`, { val: 1, ack: true, ts });
    db.setState(`${TG}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    db.setState(`${TG}.communicate.users`, { val: USERS, ack: true, ts });
    await agent.onStateChange(`${TG}.communicate.request`, { val: `[Alex]${text}`, ack: true, ts });
}
const sentToTelegram = agent => agent.sent.filter(([to]) => to === TG).map(([, , msg]) => msg.text);
const switchLamp = f =>
    f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: 'x.0.lamp', val: true }), { stopReason: 'toolUse' });

test('confirmation: "Yes" in Telegram lets the write happen, once', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...TELEGRAM, ...WRITE },
        seed: CRASH_SEED,
        responses: [switchLamp(f), f.fauxAssistantMessage('Lamp is on.')],
        hooks: { sendToAsync: (to, command) => (command === 'ask' ? { data: 'pi-agent:yes' } : undefined) },
    });
    await receive(agent, db, 1, 'switch the lamp on');
    const [instance, command, question] = agent.asked[0];
    assert.equal(`${instance}/${command}`, `${TG}/ask`);
    assert.equal(question.chatId, '100');
    assert.match(question.text, /x\.0\.lamp/);
    assert.deepEqual(
        question.reply_markup.inline_keyboard[0].map(b => b.callback_data),
        ['pi-agent:yes', 'pi-agent:no'],
    );
    assert.deepEqual(db.writes, [['x.0.lamp', true]]);
    assert.ok(agent.logs.some(([, m]) => m.includes('confirmation: yes')));
    await stopAgent(agent);
});

test('confirmation: "No" or no answer blocks the write and the model is told', async () => {
    for (const answer of [{ data: 'pi-agent:no' }, '__timeout__']) {
        const f = await faux();
        let seen = '';
        const { agent, db } = await startAgent({
            dataDir: tmp(),
            config: { ...TELEGRAM, ...WRITE },
            seed: CRASH_SEED,
            responses: [
                switchLamp(f),
                context => {
                    seen = JSON.stringify(context.messages);
                    return f.fauxAssistantMessage('Not switched.');
                },
            ],
            hooks: { sendToAsync: () => answer },
        });
        await receive(agent, db, 2, 'switch the lamp on');
        assert.deepEqual(db.writes, [], `no write for ${JSON.stringify(answer)}`);
        assert.match(seen, /did not confirm/);
        await stopAgent(agent);
    }
});

test('confirmation: a request that did not come from Telegram cannot be confirmed and is not written', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...TELEGRAM, ...WRITE },
        seed: CRASH_SEED,
        responses: [switchLamp(f), f.fauxAssistantMessage('Needs Telegram.')],
    });
    await agent.onStateChange(`${NAMESPACE}.chat.input`, { val: 'switch the lamp on', ack: false, ts: 5 });
    assert.deepEqual(db.writes, []);
    assert.equal(agent.asked, undefined, 'nobody was asked');
    assert.ok(agent.logs.some(([, m]) => m.includes('confirmation: unavailable')));
    await stopAgent(agent);
});

test('states that are not on the confirmation list are written without asking', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...TELEGRAM, ...WRITE, confirmRequired: '^other\\.' },
        seed: CRASH_SEED,
        responses: [switchLamp(f), f.fauxAssistantMessage('Done.')],
    });
    await receive(agent, db, 3, 'switch the lamp on');
    assert.deepEqual(db.writes, [['x.0.lamp', true]]);
    assert.equal(agent.asked, undefined);
    await stopAgent(agent);
});

test('a reminder survives a restart and arrives in the Telegram chat', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({
        dataDir,
        config: TELEGRAM,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('remind_me', { minutes: 0.1, text: 'Check the window' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('I will remind you.'),
        ],
    });
    await receive(first.agent, first.db, 4, 'remind me in a few seconds');
    assert.deepEqual(sentToTelegram(first.agent), ['I will remind you.']);
    await stopAgent(first.agent); // the reminder is due ~6 s later, while this instance is gone

    const second = await startAgent({ dataDir, config: TELEGRAM, responses: [] });
    await waitFor(() => sentToTelegram(second.agent).length > 0, 'the reminder', 20000);
    assert.deepEqual(sentToTelegram(second.agent), ['⏰ Check the window']);
    await stopAgent(second.agent);
});

test('a reminder outside 7 days is refused', async () => {
    const f = await faux();
    let seen = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('remind_me', { minutes: 60 * 24 * 30, text: 'x' }), {
                stopReason: 'toolUse',
            }),
            context => {
                seen = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('Too far.');
            },
        ],
    });
    await receive(agent, db, 5, 'remind me next month');
    assert.match(seen, /at most 7 days/);
    await stopAgent(agent);
});

test('history comes from the default history instance of the system settings', async () => {
    const f = await faux();
    let seen = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: TELEGRAM,
        seed: { objects: { 'system.config': { type: 'config', common: { defaultHistory: 'history.0' } } } },
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
            sendToAsync: (to, command) =>
                to === 'history.0' && command === 'getHistory'
                    ? {
                          result: [
                              { val: 20.5, ts: 1 },
                              { val: 21, ts: 2 },
                          ],
                      }
                    : undefined,
        },
    });
    await receive(agent, db, 6, 'how warm was it?');
    const [instance, command, request] = agent.asked[0];
    assert.equal(`${instance}/${command}`, 'history.0/getHistory');
    assert.equal(request.id, 'x.0.temp');
    assert.equal(request.options.count, 3);
    assert.equal(request.options.aggregate, 'average');
    assert.match(seen, /20\.5/);
    await stopAgent(agent);
});

test('usage states show the tokens of the answered requests', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        responses: [f.fauxAssistantMessage('Hello')],
    });
    await agent.onStateChange(`${NAMESPACE}.chat.input`, { val: 'Hi', ack: false, ts: 9 });
    await waitFor(() => db.states[`${NAMESPACE}.usage.tokensTotal`]?.val > 0, 'usage to be published');
    const usage = JSON.parse(db.states[`${NAMESPACE}.usage.json`].val);
    assert.ok(Object.keys(usage.models).length === 1, JSON.stringify(usage));
    assert.ok(db.states[`${NAMESPACE}.usage.tokensInput`].val > 0);
    await stopAgent(agent);
});

test('time zone: get_time, remind_me and get_history speak the local time of the house', async () => {
    const { formatLocal } = require('../lib/time');
    const f = await faux();
    const zone = 'Asia/Tokyo'; // far from the test machine, so a mix-up with UTC or the server zone shows
    const inTwoMinutes = formatLocal(Date.now() + 120_000, zone, { zone: false });
    const seen = [];
    const capture = reply => context => {
        seen.push(JSON.stringify(context.messages));
        return reply;
    };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...TELEGRAM, timeZone: zone },
        seed: { objects: { 'system.config': { type: 'config', common: { defaultHistory: 'history.0' } } } },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_time', {}), { stopReason: 'toolUse' }),
            capture(
                f.fauxAssistantMessage(f.fauxToolCall('remind_me', { at: inTwoMinutes, text: 'window' }), {
                    stopReason: 'toolUse',
                }),
            ),
            capture(f.fauxAssistantMessage(f.fauxToolCall('get_history', { id: 'x.0.t' }), { stopReason: 'toolUse' })),
            capture(f.fauxAssistantMessage('ok')),
        ],
        hooks: { sendToAsync: () => ({ result: [{ val: 1, ts: Date.parse('2026-10-26T00:30:00Z') }] }) },
    });
    assert.ok(agent.logs.some(([, m]) => m === `Time zone: ${zone}`));
    await receive(agent, db, 7, 'time things');
    assert.match(seen[0], /Asia\/Tokyo/);
    assert.match(seen[0], /"weekday/);
    assert.ok(seen[1].includes(`Reminder set for ${inTwoMinutes} (Asia/Tokyo)`), seen[1]);
    assert.ok(seen[2].includes('2026-10-26 09:30'), 'history time in Tokyo time (UTC+9)');
    await stopAgent(agent);
});

test('time zone: a wrong name is reported and the server zone is used', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), config: { timeZone: 'Berlin' }, responses: [] });
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('Unknown time zone "Berlin"')));
    await stopAgent(agent);
});

test('the table "Write permissions" allows and asks like the regular expressions', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: {
            ...TELEGRAM,
            dryRun: false,
            writeRules: [
                { scope: 'x.0', write: true, confirm: true },
                { scope: 'y.0', write: false, confirm: false },
            ],
        },
        seed: CRASH_SEED,
        responses: [switchLamp(f), f.fauxAssistantMessage('Lamp is on.')],
        hooks: { sendToAsync: (to, command) => (command === 'ask' ? { data: 'pi-agent:yes' } : undefined) },
    });
    await receive(agent, db, 1, 'switch the lamp on');
    assert.equal(agent.asked.length, 1, 'asked because of "confirm"');
    assert.deepEqual(db.writes, [['x.0.lamp', true]]);
    await stopAgent(agent);
});

test('sendTo "toggleColumn" switches one checkbox column for all rows where it counts', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), seed: { objects: {} }, responses: [] });
    const toggle = (column, writeRules) =>
        new Promise(resolve => {
            agent.sendTo = (to, command, message) => resolve(message);
            agent.onMessage({
                command: 'toggleColumn',
                message: { column, writeRules },
                from: 'system.adapter.admin.0',
                callback: {},
            });
        });
    const rows = [
        { scope: 'hm-rpc.0', write: true, confirm: false, restart: false },
        { scope: 'shelly.0.*.Switch', write: false, confirm: false, restart: false },
        { scope: 'admin.0', write: false, confirm: false, restart: false },
    ];
    const write = (await toggle('write', rows)).native.writeRules;
    assert.deepEqual(
        write.map(r => r.write),
        [true, true, true],
        'not all set: all on',
    );
    assert.deepEqual(
        (await toggle('write', write)).native.writeRules.map(r => r.write),
        [false, false, false],
        'all set: all off',
    );
    assert.deepEqual(
        (await toggle('confirm', rows)).native.writeRules.map(r => r.confirm),
        [true, false, false],
        'only where writing is allowed',
    );
    assert.deepEqual(
        (await toggle('restart', rows)).native.writeRules.map(r => r.restart),
        [true, false, false],
        'only a whole instance, never admin',
    );
    assert.match((await toggle('scope', rows)).error, /Unknown column scope/);
    await stopAgent(agent);
});

test('sendTo "importInstances" adds a row for every installed instance that has none', async () => {
    const instance = (type, title) => ({ type: 'instance', common: { type, title } });
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: {
            objects: {
                'system.adapter.admin.0': instance('general'),
                'system.adapter.history.0': instance('storage'),
                'system.adapter.hm-rpc.0': instance('hardware'),
                'system.adapter.javascript.0': instance('logic'),
                'system.adapter.pi-agent.0': instance('logic'),
                'system.adapter.shelly.0': instance('hardware'),
            },
        },
        responses: [],
    });
    const answer = await new Promise(resolve => {
        agent.sendTo = (to, command, message) => resolve(message);
        agent.onMessage({
            command: 'importInstances',
            message: { writeRules: [{ scope: 'shelly.0', write: true, confirm: false }] },
            from: 'system.adapter.admin.0',
            callback: {},
        });
    });
    assert.deepEqual(answer, {
        native: {
            writeRules: [
                { scope: 'shelly.0', write: true, confirm: false },
                { scope: 'hm-rpc.0', write: false, confirm: false, restart: false },
                { scope: 'javascript.0', write: false, confirm: false, restart: false },
            ],
        },
    });
    await stopAgent(agent);
});
