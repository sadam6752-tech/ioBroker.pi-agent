'use strict';

// The chat of the admin tab (admin/tab.html) through the real main.js: the commands chatSend, chatHistory,
// chatConfirm and chatNew, one conversation per ioBroker user, and the history as the page shows it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');
const { historyOf, withNotices } = require('../lib/admin-chat');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-admin-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

/** Send a command like the admin tab does and return the answer of the adapter. */
function call(agent, command, message = {}, user = 'system.user.admin') {
    if (!agent.calls) {
        agent.calls = new Map();
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer, callback) => {
            const resolve = agent.calls.get(callback);
            return resolve ? (agent.calls.delete(callback), resolve(answer)) : sendTo(to, cmd, answer, callback);
        };
    }
    return new Promise(resolve => {
        const callback = { id: Math.random() };
        agent.calls.set(callback, resolve);
        agent.onMessage({ command, message, user, from: 'system.adapter.admin.0', callback });
    });
}

/** History once the agent has finished. */
async function settled(agent, user) {
    let history;
    await waitFor(async () => {
        history = await call(agent, 'chatHistory', {}, user);
        return !history.busy;
    }, 'the request to finish');
    return history;
}

test('historyOf: user text, tool calls and answers as HTML, system entries left out; details and summary', () => {
    const usage = (input, output, cacheRead) => ({ input, output, cacheRead });
    const entries = [
        { kind: 'pi.user', model: [{ role: 'user', content: 'lamp <on>?', timestamp: 1000 }] },
        { kind: 'pi.system', model: [{ role: 'system', content: 'secret prompt' }] },
        {
            kind: 'pi.assistant',
            model: [
                {
                    role: 'assistant',
                    timestamp: 2000,
                    provider: 'deepseek',
                    model: 'deepseek-flash',
                    usage: usage(900, 10, 800),
                    content: [{ type: 'toolCall', id: 'c1', name: 'get_state', arguments: { id: 'x.0.lamp' } }],
                },
            ],
        },
        {
            kind: 'pi.tool-result',
            model: [
                {
                    role: 'toolResult',
                    toolCallId: 'c1',
                    content: [{ type: 'text', text: `{"val":false,"pad":"${'x'.repeat(400)}"}` }],
                    isError: false,
                    durationMs: 41,
                    timestamp: 2500,
                },
            ],
        },
        {
            kind: 'pi.assistant',
            model: [
                {
                    role: 'assistant',
                    timestamp: 14_000,
                    provider: 'deepseek',
                    model: 'deepseek-flash',
                    usage: usage(100, 20, 900),
                    content: [{ type: 'text', text: '**Off** <b>' }],
                },
            ],
        },
    ];
    const history = historyOf(entries);
    assert.deepEqual(
        history.map(({ role, text, html, ts }) => ({ role, text, html, ts })),
        [
            { role: 'user', text: 'lamp <on>?', html: undefined, ts: 1000 },
            { role: 'tool', text: 'get_state x.0.lamp', html: undefined, ts: 2000 },
            { role: 'assistant', text: undefined, html: '<b>Off</b> &lt;b&gt;', ts: 14_000 },
        ],
    );
    const detail = history[1].detail;
    assert.equal(detail.name, 'get_state');
    assert.equal(detail.args, '{"id":"x.0.lamp"}');
    assert.equal(detail.result.length, 301, 'the result is cut to 300 characters and …');
    assert.equal(detail.ms, 41);
    assert.equal(detail.error, false);
    assert.deepEqual(history[2].summary, {
        provider: 'deepseek',
        model: 'deepseek-flash',
        input: 1000,
        output: 30,
        cached: 1700,
        calls: 2,
        ms: 13_000,
    });
});

test('chat of another conversation: only administrators, only read; the list names the sources', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        // a copy: the fake database writes into the seed it is given
        seed: structuredClone(CRASH_SEED),
        responses: [f.fauxAssistantMessage('Kitchen light is off.'), f.fauxAssistantMessage('Hello Bob')],
    });
    db.objects['system.group.administrator'] = { common: { members: ['system.user.admin', 'system.user.alice'] } };
    // a request of a sendTo caller with a conversation of its own, as ioBroker.assistant sends it
    const answer = await new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, result) => {
            agent.sendTo = sendTo;
            resolve(result);
        };
        agent.onMessage({
            command: 'ask',
            message: { text: 'kitchen light?', conversation: 'kitchen', requestId: 'r1' },
            from: 'system.adapter.assistant.0',
            callback: { id: 1 },
        });
    });
    assert.equal(answer.answer, 'Kitchen light is off.');
    await call(agent, 'chatSend', { text: 'hi' }, 'system.user.bob');
    await settled(agent, 'system.user.bob');

    const list = (await call(agent, 'chatConversations', {}, 'system.user.alice')).conversations;
    assert.deepEqual(
        list.map(c => [c.kind, c.source, c.name, c.own]),
        [
            ['admin', 'admin', 'alice', true],
            ['admin', 'admin', 'bob', false],
            ['sendTo', 'assistant.0', 'kitchen', false],
        ],
    );
    const kitchen = list.find(c => c.kind === 'sendTo').key;
    const view = await call(agent, 'chatHistory', { conversation: kitchen }, 'system.user.alice');
    assert.equal(view.readOnly, true);
    assert.deepEqual(
        view.entries.map(e => e.role),
        ['user', 'assistant'],
    );
    assert.equal(view.entries[1].summary.calls, 1);

    // bob is no administrator: his list has only his own chat, and another conversation is refused
    assert.equal((await call(agent, 'chatConversations', {}, 'system.user.bob')).conversations.length, 1);
    assert.deepEqual(await call(agent, 'chatHistory', { conversation: kitchen }, 'system.user.bob'), {
        error: 'forbidden',
    });
    // the own chat stays writable
    assert.equal((await call(agent, 'chatHistory', {}, 'system.user.bob')).readOnly, false);
    await stopAgent(agent);
});

test('admin chat: a question is answered in the user\'s own conversation, with the tool calls', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: CRASH_SEED,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_state', { id: 'x.0.lamp' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('The lamp is **off**.'),
            f.fauxAssistantMessage('Hello Bob'),
        ],
    });
    assert.deepEqual(await call(agent, 'chatSend', { text: 'is the lamp on?' }), { accepted: true });
    const history = await settled(agent);
    assert.equal(history.running, true);
    assert.equal(history.simulation, true);
    assert.equal(history.user, 'system.user.admin');
    assert.deepEqual(
        history.entries.map(e => [e.role, e.text || e.html]),
        [
            ['user', 'is the lamp on?'],
            ['tool', 'get_state x.0.lamp'],
            ['assistant', 'The lamp is <b>off</b>.'],
        ],
    );
    assert.equal(db.states[`${NAMESPACE}.chat.answer`], undefined, 'the answer stays in the tab');

    // another ioBroker user has a conversation of their own
    await call(agent, 'chatSend', { text: 'hi' }, 'system.user.bob');
    const bob = await settled(agent, 'system.user.bob');
    assert.deepEqual(
        bob.entries.map(e => e.role),
        ['user', 'assistant'],
    );
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), ['admin/system.user.admin', 'admin/system.user.bob']);

    // a new conversation starts empty
    assert.deepEqual(await call(agent, 'chatNew'), { ok: true });
    assert.deepEqual((await call(agent, 'chatHistory')).entries, []);
    assert.equal((await call(agent, 'chatHistory', {}, 'system.user.bob')).entries.length, 2);
    await stopAgent(agent);
});

test('admin chat: a write that needs confirmation is asked in the tab and done after "yes"', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'x.0', write: true, confirm: true }] },
        seed: CRASH_SEED,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: 'x.0.lamp', val: true }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Lamp is on.'),
        ],
    });
    await call(agent, 'chatSend', { text: 'lamp on' });
    let question;
    await waitFor(async () => {
        question = (await call(agent, 'chatHistory')).question;
        return question;
    }, 'the question');
    assert.equal(question.id, 'x.0.lamp');
    assert.equal(question.val, true);
    assert.deepEqual(db.writes, [], 'nothing written before the answer');
    assert.deepEqual(await call(agent, 'chatSend', { text: 'again' }), { error: 'busy' });
    assert.deepEqual(await call(agent, 'chatConfirm', { nonce: 'wrong', answer: 'yes' }), { ok: false });
    assert.deepEqual(await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' }), { ok: true });
    const history = await settled(agent);
    assert.deepEqual(db.writes, [['x.0.lamp', true]]);
    assert.equal(history.question, null);
    assert.equal(history.entries.at(-1).html, 'Lamp is on.');
    await stopAgent(agent);
});

test('admin chat: a failed request shows its error; an empty text is refused', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [f.fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' })],
    });
    assert.deepEqual(await call(agent, 'chatSend', { text: '  ' }), { error: 'empty' });
    await call(agent, 'chatSend', { text: 'hello' });
    const history = await settled(agent);
    assert.ok(history.error, 'the error is shown');
    await stopAgent(agent);
});

test('withNotices: a reminder stands before the first question asked after it', () => {
    const entries = [
        { role: 'user', text: 'a', ts: 10 },
        { role: 'assistant', html: 'A', ts: 5 },
        { role: 'user', text: 'b', ts: 30 },
        { role: 'assistant', html: 'B', ts: 7 },
    ];
    const notice = ts => ({ role: 'notice', html: `n${ts}`, ts });
    assert.deepEqual(
        withNotices(entries, [notice(20), notice(40)]).map(e => e.text || e.html),
        ['a', 'A', 'n20', 'b', 'B', 'n40'],
    );
});

test('a request refused by the daily limit ends with its error in the chat, not with "thinking"', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), config: { dailyTokens: 1000 }, responses: [] });
    // the day is over the limit
    agent.limits.restore(5000, Date.now(), 0);
    assert.deepEqual(await call(agent, 'chatSend', { text: 'hello' }), { accepted: true });
    const history = await settled(agent);
    assert.equal(history.busy, false);
    assert.ok(Array.isArray(history.entries));
    assert.match(String(history.error), /daily token limit \(1000\) is reached/);
    // the page takes such an answer as the chat, not as "the adapter does not answer"
    const page = fs.readFileSync(path.join(__dirname, '../admin/tab.html'), 'utf8');
    assert.match(page, /offline = Boolean\(answer\.error\) && !Array\.isArray\(answer\.entries\);/);
    await stopAgent(agent);
});
