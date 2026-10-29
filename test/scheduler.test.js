'use strict';

// 0.6.4: the scheduler adapter fullcalendar — the prompt says when to use it or that it is missing, and the state an
// event writes (oid) needs the write permission of pi-agent, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-sched-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const FC = 'system.adapter.fullcalendar.0';
const HEATER = 'hm-rpc.0.heater.STATE';
const seed = (withScheduler = true) => ({
    objects: {
        ...(withScheduler ? { [FC]: { type: 'instance', common: { enabled: true, mode: 'daemon' } } } : {}),
        [HEATER]: { type: 'state', common: { name: 'Heater', type: 'boolean', role: 'switch', read: true, write: true } },
    },
    states: {},
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

/** Ask in the admin chat; return the prompt the model saw and the result of the last tool call. */
async function ask(agent, text) {
    const call = page(agent);
    await call('chatSend', { text });
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    const history = await call('chatHistory');
    return String(history.entries.findLast(e => e.role === 'tool')?.detail?.result ?? '');
}

/** A model that records its prompt and then calls a tool. */
function recording(f, prompts, name, args) {
    return [
        ctx => {
            prompts.push(JSON.stringify(ctx));
            return f.fauxAssistantMessage(f.fauxToolCall(name, args), { stopReason: 'toolUse' });
        },
        f.fauxAssistantMessage('ok'),
    ];
}

test('not installed: the prompt says so, and a time beyond 7 days names the adapter', async () => {
    const f = await faux();
    const prompts = [];
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: seed(false),
        responses: recording(f, prompts, 'schedule_set_state', { id: HEATER, val: false, minutes: 14 * 24 * 60 }),
    });
    const result = await ask(agent, 'switch the heater off in two weeks');
    assert.match(prompts[0], /The scheduler adapter fullcalendar is not installed/);
    assert.match(result, /needs the scheduler adapter fullcalendar, which is not installed/);
    await stopAgent(agent);
});

test('installed but not allowed: the prompt says what the user has to allow', async () => {
    const f = await faux();
    const prompts = [];
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: seed(),
        responses: recording(f, prompts, 'get_time', {}),
    });
    await ask(agent, 'hi');
    assert.match(prompts[0], /fullcalendar\.0 \(adapter fullcalendar\) is installed, but pi-agent may not send it commands/);
    await stopAgent(agent);
});

test('installed and allowed: events go to fullcalendar, but only for states pi-agent may write', async () => {
    const f = await faux();
    const prompts = [];
    const sent = [];
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: {
            dryRun: false,
            writeRules: [
                { scope: 'fullcalendar.0', write: true },
                { scope: 'hm-rpc.0', write: true },
            ],
        },
        seed: seed(),
        hooks: {
            sendToAsync: async (instance, command, message) => {
                sent.push([instance, command, message]);
                return command === 'getEvent' ? { event: { oid: 'zigbee.0.lock.state' } } : { id: 'fullcalendar.0.event-1' };
            },
        },
        responses: [
            ...recording(f, prompts, 'send_to', {
                instance: 'fullcalendar.0',
                command: 'addEvent',
                message: { oid: HEATER, value: false, start: '23:00', recurring: 'daily' },
            }),
            f.fauxAssistantMessage(
                f.fauxToolCall('send_to', { instance: 'fullcalendar.0', command: 'addEvent', message: { oid: 'zigbee.0.lock.state', value: true, in: '1h' } }),
                { stopReason: 'toolUse' },
            ),
            f.fauxAssistantMessage('blocked'),
            f.fauxAssistantMessage(
                f.fauxToolCall('send_to', { instance: 'fullcalendar.0', command: 'updateEvent', message: { id: 'fullcalendar.0.event-9', start: '09:00' } }),
                { stopReason: 'toolUse' },
            ),
            f.fauxAssistantMessage('blocked too'),
        ],
    });
    assert.match(await ask(agent, 'every day at 23:00 heater off'), /^Sent\. Answer of fullcalendar\.0/);
    assert.match(prompts[0], /use the scheduler fullcalendar\.0 \(adapter fullcalendar\) with send_to/);
    assert.match(prompts[0], /fullcalendar\.0\.events\.today/);
    assert.deepEqual(sent.at(-1), ['fullcalendar.0', 'addEvent', { oid: HEATER, value: false, start: '23:00', recurring: 'daily' }]);

    // an event for a state pi-agent may not write: blocked, nothing sent
    assert.match(await ask(agent, 'unlock in an hour'), /would write zigbee\.0\.lock\.state, which is not on the write allowlist/);
    assert.equal(sent.filter(([, command]) => command === 'addEvent').length, 1);

    // updateEvent without oid: the state of the event is looked up first
    assert.match(await ask(agent, 'move it'), /would write zigbee\.0\.lock\.state/);
    assert.deepEqual(sent.at(-1), ['fullcalendar.0', 'getEvent', { id: 'fullcalendar.0.event-9' }]);
    await stopAgent(agent);
});

test('an event for a state with "Confirmation required" is asked with what and when', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: {
            dryRun: false,
            writeRules: [
                { scope: 'fullcalendar.0', write: true },
                { scope: 'hm-rpc.0', write: true, confirm: true },
            ],
        },
        seed: seed(),
        hooks: { sendToAsync: async () => ({ id: 'fullcalendar.0.event-1' }) },
        responses: [
            f.fauxAssistantMessage(
                f.fauxToolCall('send_to', {
                    instance: 'fullcalendar.0',
                    command: 'addEvent',
                    message: { oid: HEATER, value: false, start: '23:00', recurring: 'daily' },
                }),
                { stopReason: 'toolUse' },
            ),
            f.fauxAssistantMessage('ok'),
        ],
    });
    const call = page(agent);
    await call('chatSend', { text: 'every day at 23:00 heater off' });
    let question;
    await waitFor(async () => (question = (await call('chatHistory')).question), 'the question');
    assert.equal(question.action, 'sendTo');
    assert.equal(question.val, `addEvent: ${HEATER} = false, start 23:00, recurring daily`);
    await call('chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    await stopAgent(agent);
});

test('the list of schedulers follows an installation', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({ dataDir: tmp(), seed: seed(false), responses: [f.fauxAssistantMessage('hi')] });
    assert.deepEqual(agent.schedulers, []);
    assert.ok(agent.objectSubscriptions.includes('system.adapter.fullcalendar.*'));
    db.objects[FC] = { type: 'instance', common: { enabled: true } };
    agent.emit('objectChange', FC, db.objects[FC]);
    await waitFor(async () => agent.schedulers.length === 1, 'the new instance');
    assert.deepEqual(agent.schedulers, ['fullcalendar.0']);
    await stopAgent(agent);
});
