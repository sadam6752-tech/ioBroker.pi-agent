'use strict';

// 0.6.3: notify_when (watches), schedule_set_state, list_scheduled / cancel_scheduled, get_logs and
// list_notifications, through the real main.js and the tools as the model calls them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { meets } = require('../lib/watches');
const { readLog, flattenNotifications } = require('../lib/diagnostics');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-063-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const POWER = 'shelly.0.washer.power';
const HEATER = 'hm-rpc.0.heater.STATE';
const SEED = () => ({
    objects: {
        [POWER]: { type: 'state', common: { name: 'Washer power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
        [HEATER]: { type: 'state', common: { name: 'Heater', type: 'boolean', role: 'switch', read: true, write: true } },
    },
    states: { [POWER]: { val: 400, ack: true, ts: 1 }, [HEATER]: { val: true, ack: true, ts: 1 } },
});

/** Commands like the admin page sends them. */
function page(agent) {
    return (command, message = {}) =>
        new Promise(resolve => {
            const sendTo = agent.sendTo.bind(agent);
            agent.sendTo = (to, cmd, answer) => {
                agent.sendTo = sendTo;
                resolve(answer);
            };
            agent.onMessage({ command, message, user: 'system.user.admin', from: 'system.adapter.admin.0', callback: { id: 1 } });
        });
}

/** Ask in the admin chat and return the raw result of the last tool call. */
async function ask(agent, text) {
    const call = page(agent);
    await call('chatSend', { text });
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    const conversation = await agent.harness.conversation(agent.chats['admin/system.user.admin'], agent.context);
    const view = await conversation.viewState(agent.context);
    const results = view.value.entries
        .filter(e => e.kind === 'pi.tool-result')
        .flatMap(e => e.model)
        .map(m => m.content.map(p => p.text).join(''));
    view.dispose?.();
    return results.at(-1) ?? '';
}

/** The reminders and notices the admin chat shows. */
const notices = agent => agent.adminChat.notices('system.user.admin').map(n => n.html);

/** A tool call turn and a closing answer, as faux responses. */
const turn = (f, name, args) => [f.fauxAssistantMessage(f.fauxToolCall(name, args), { stopReason: 'toolUse' }), f.fauxAssistantMessage('ok')];

test('meets: numbers, text and true/false', () => {
    assert.equal(meets(3, '<', 5), true);
    assert.equal(meets('3', '<', '5'), true);
    assert.equal(meets(5, '>=', 5), true);
    assert.equal(meets(true, '==', 'true'), true);
    assert.equal(meets(1, '==', true), true);
    assert.equal(meets(false, '!=', true), true);
    assert.equal(meets('open', '==', 'open'), true);
    assert.equal(meets('x', '>', 3), false);
});

test('notify_when: fires once in the chat when the device reports the value; a command does not count', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'notify_when', { id: POWER, condition: '<', value: 5, text: 'The washing machine is done' }),
    });
    assert.match(await ask(agent, 'tell me when the washer is done'), /^Watch w[0-9a-f]+ set/);
    assert.ok(agent.foreignSubscriptions.includes(POWER));
    await agent.onStateChange(POWER, { val: 2, ack: false, ts: 2 }); // a command, not the device
    assert.deepEqual(notices(agent), []);
    await agent.onStateChange(POWER, { val: 2, ack: true, ts: 3 });
    await waitFor(async () => notices(agent).length === 1, 'the notice');
    assert.match(notices(agent)[0], /The washing machine is done/);
    assert.deepEqual(JSON.parse(db.states[`${NAMESPACE}.scheduled.watches`].val), [], 'ended after firing');
    await agent.onStateChange(POWER, { val: 1, ack: true, ts: 4 });
    assert.equal(notices(agent).length, 1, 'once');
    await stopAgent(agent);
});

test('notify_when: "for minutes" needs the condition to hold; an interruption starts it again', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'notify_when', { id: POWER, condition: '<', value: 5, minutes: 0.005, text: 'Done' }),
    });
    await ask(agent, 'watch');
    await agent.onStateChange(POWER, { val: 2, ack: true, ts: 2 });
    await sleep(100);
    await agent.onStateChange(POWER, { val: 300, ack: true, ts: 3 }); // broke off before 300 ms
    await sleep(400);
    assert.deepEqual(notices(agent), []);
    await agent.onStateChange(POWER, { val: 1, ack: true, ts: 4 });
    await waitFor(async () => notices(agent).length === 1, 'the notice after the duration');
    await stopAgent(agent);
});

test('notify_when: "changes", and a watch survives a restart of the adapter', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({
        dataDir,
        seed: SEED(),
        responses: turn(f, 'notify_when', { id: HEATER, condition: 'changes', text: 'The heater switched' }),
    });
    await ask(first.agent, 'tell me when the heater switches');
    await first.agent.onStateChange(HEATER, { val: true, ack: true, ts: 2 }); // the same value: no change
    assert.deepEqual(notices(first.agent), []);
    await stopAgent(first.agent);

    const second = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('hi')] });
    assert.ok(second.agent.foreignSubscriptions.includes(HEATER), 'subscribed again at the start');
    assert.equal(second.agent.watches.list(second.agent.chats['admin/system.user.admin']).length, 1);
    await second.agent.onStateChange(HEATER, { val: false, ack: true, ts: 3 });
    await waitFor(async () => notices(second.agent).length === 1, 'the notice after the restart');
    await stopAgent(second.agent);
});

test('schedule_set_state: written when due, the user is told; no write before', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: turn(f, 'schedule_set_state', { id: HEATER, val: false, minutes: 0.09 }),
    });
    assert.match(await ask(agent, 'switch the heater off in 5 seconds'), /^Planned: hm-rpc\.0\.heater\.STATE = false at /);
    assert.deepEqual(db.writes, []);
    await waitFor(async () => db.writes.length === 1, 'the write', 15000);
    assert.deepEqual(db.writes, [[HEATER, false]]);
    await waitFor(async () => notices(agent).some(n => n.includes('Done')), 'the message');
    await stopAgent(agent);
});

test('schedule_set_state: a permission taken away in the meantime stops the write', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: turn(f, 'schedule_set_state', { id: HEATER, val: false, minutes: 0.09 }),
    });
    await ask(agent, 'switch the heater off later');
    agent.allowlist = [];
    await waitFor(async () => notices(agent).some(n => n.includes('no longer allowed')), 'the message', 15000);
    assert.deepEqual(db.writes, []);
    await stopAgent(agent);
});

test('schedule_set_state: not allowed now is refused at once; with confirmation the user is asked now', async () => {
    const f = await faux();
    const blocked = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [] },
        seed: SEED(),
        responses: turn(f, 'schedule_set_state', { id: HEATER, val: false, minutes: 60 }),
    });
    assert.match(await ask(blocked.agent, 'later'), /not on the write allowlist/);
    await stopAgent(blocked.agent);

    const asked = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true, confirm: true }] },
        seed: SEED(),
        responses: turn(f, 'schedule_set_state', { id: HEATER, val: false, minutes: 60 }),
    });
    const call = page(asked.agent);
    await call('chatSend', { text: 'later' });
    let question;
    await waitFor(async () => (question = (await call('chatHistory')).question), 'the question');
    assert.deepEqual([question.id, question.val], [HEATER, false]);
    await call('chatConfirm', { nonce: question.nonce, answer: 'no' });
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    await stopAgent(asked.agent);
});

test('list_scheduled shows reminders, writes and watches; cancel_scheduled ends them, only in this conversation', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: [
            ...turn(f, 'remind_me', { text: 'Call mum', minutes: 60 }),
            ...turn(f, 'schedule_set_state', { id: HEATER, val: false, minutes: 120 }),
            ...turn(f, 'notify_when', { id: POWER, condition: '<', value: 5, text: 'Done' }),
            ...turn(f, 'list_scheduled', {}),
            ...turn(f, 'cancel_scheduled', { id: 'PLACEHOLDER' }),
        ],
    });
    await ask(agent, 'remind me');
    await ask(agent, 'heater off later');
    await ask(agent, 'tell me when done');
    const listed = JSON.parse(await ask(agent, 'what is planned?'));
    assert.deepEqual(
        listed.planned.map(p => p.kind),
        ['reminder', 'scheduled write'],
    );
    assert.equal(listed.watches.length, 1);

    // cancel through the same paths the tool uses
    const conversationId = agent.chats['admin/system.user.admin'];
    const write = listed.planned.find(p => p.kind === 'scheduled write');
    assert.equal(await agent.cancelPlanned('999999', write.id), false, 'not from another conversation');
    assert.equal(await agent.cancelPlanned(conversationId, write.id), true);
    assert.equal(await agent.watches.cancel(conversationId, listed.watches[0].id), true);
    await waitFor(async () => (await agent.plannedTasks(conversationId)).length === 1, 'the write to end');
    assert.deepEqual(agent.watches.list(conversationId), []);
    assert.deepEqual(db.writes, []);
    assert.match(await ask(agent, 'cancel'), /Nothing with id PLACEHOLDER/);
    await stopAgent(agent);
});

test('get_logs: the newest lines of the log file, by instance, level and word', async () => {
    const dataDir = path.join(tmp(), 'iobroker-data');
    fs.mkdirSync(path.join(dataDir, '..', 'log'), { recursive: true });
    const line = (level, source, message) =>
        `2026-10-29 10:00:00.000  - \x1b[32m${level}\x1b[39m: ${source} (123) ${message}`;
    fs.writeFileSync(
        path.join(dataDir, '..', 'log', 'iobroker.current.log'),
        [
            line('info', 'zigbee.0', 'started'),
            line('warn', 'zigbee.0', 'device 0x12 not answering'),
            line('error', 'zigbee.0', 'port /dev/ttyACM0 not found'),
            line('error', 'hue.0', 'bridge offline'),
            'a line that is not a log line',
        ].join('\n'),
    );
    const file = path.join(dataDir, '..', 'log', 'iobroker.current.log');
    assert.deepEqual(
        readLog(file, { instance: 'zigbee' }).map(l => l.level),
        ['warn', 'error'],
    );
    assert.deepEqual(
        readLog(file, { level: 'error' }).map(l => l.source),
        ['zigbee.0', 'hue.0'],
    );
    assert.equal(readLog(file, { level: 'info', count: 1 })[0].message, '(123) bridge offline');
    assert.equal(readLog(file, { level: 'info', search: 'ttyacm' }).length, 1);

    process.env.PI_AGENT_TEST_DATA_DIR = dataDir;
    try {
        const f = await faux();
        const { agent } = await startAgent({ dataDir: tmp(), responses: turn(f, 'get_logs', { instance: 'zigbee.0', level: 'error' }) });
        const result = JSON.parse(await ask(agent, 'why does zigbee not work?'));
        assert.equal(result.lines.length, 1);
        assert.match(result.lines[0].message, /ttyACM0/);
        await stopAgent(agent);
    } finally {
        delete process.env.PI_AGENT_TEST_DATA_DIR;
    }
});

test('list_notifications: the messages of the notification states of the host', async () => {
    const value = {
        categories: {
            accessErrors: { instances: { 'system.adapter.zigbee.0': { messages: [{ message: 'No access to the port', ts: 5 }] } } },
        },
    };
    assert.deepEqual(flattenNotifications('system', value), [
        { scope: 'system', category: 'accessErrors', instance: 'zigbee.0', message: 'No access to the port', ts: 5 },
    ]);
    const f = await faux();
    const id = 'system.host.iobroker.notifications.system';
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: {
            objects: { [id]: { type: 'state', common: { name: 'notifications', type: 'string', read: true, write: false } } },
            states: { [id]: { val: JSON.stringify(value), ack: true, ts: 1 } },
        },
        responses: turn(f, 'list_notifications', {}),
    });
    const result = JSON.parse(await ask(agent, 'any problems?'));
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].instance, 'zigbee.0');
    await stopAgent(agent);
});
