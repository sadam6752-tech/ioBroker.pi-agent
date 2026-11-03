'use strict';

// The MAX path of main.js against a stand-in max.0: private dialog and group chat, plain text, confirmation
// with callback buttons (MAX has no "ask"), and a MAX bot next to a Telegram bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');
const { markdownToPlain } = require('../lib/messengers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-max-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const MAX = 'max.0';
const CONFIG = { messengers: [{ enabled: true, instance: MAX, users: 'Alex, 9', prefix: '' }] };

/** Let the stand-in max.0 receive a message, like the max adapter writes it (chat 0 = private dialog). */
async function receive(agent, db, { chatId = 0, userId, messageId, name, text }) {
    const ts = Date.now();
    db.setState(`${MAX}.communicate.requestChatId`, { val: chatId, ack: true, ts });
    db.setState(`${MAX}.communicate.requestUserId`, { val: userId, ack: true, ts });
    db.setState(`${MAX}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    await agent.onStateChange(`${MAX}.communicate.request`, { val: `[${name}]${text}`, ack: true, ts });
}

const sentToMax = agent => agent.sent.filter(([to]) => to === MAX).map(([, command, msg]) => ({ command, ...msg }));
const knownUser = { states: { [`${MAX}.users.7.username`]: { val: 'Alex', ack: true, ts: 1 } } };

test('MAX: a private dialog is answered to the user, a group chat to the chat, in plain text', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        seed: knownUser,
        responses: [f.fauxAssistantMessage('**Hi** Alex'), f.fauxAssistantMessage('Hi `group`')],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${MAX}.communicate.request`]);
    // "Alex" counts: max.0 knows user 7 by this name; user 8 calling himself Alex does not
    await receive(agent, db, { userId: 7, messageId: 'm1', name: 'Alex', text: 'hello' });
    await receive(agent, db, { userId: 8, messageId: 'm2', name: 'Alex', text: 'hello' });
    // group members are known by id only
    await receive(agent, db, { chatId: -55, userId: 9, messageId: 'm3', name: 'Bob', text: 'hello' });
    assert.deepEqual(sentToMax(agent), [
        { command: 'send', userId: '7', text: 'Hi Alex' },
        { command: 'send', chatId: '-55', text: 'Hi group' },
    ]);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('MAX message on max.0 from Alex (8) ignored')));
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), [`${MAX}/-55`, `${MAX}/u7`]);
    await stopAgent(agent);
});

test('MAX: a confirmation is asked with callback buttons; the pressed button decides and is not a message', async () => {
    const f = await faux();
    const seen = [];
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...CONFIG, writeAllow: '^x\\.0\\.', confirmRequired: '^x\\.0\\.', dryRun: false },
        seed: { ...CRASH_SEED, states: { ...CRASH_SEED.states, ...knownUser.states } },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: 'x.0.lamp', val: true }), { stopReason: 'toolUse' }),
            context => {
                seen.push(JSON.stringify(context));
                return f.fauxAssistantMessage('Lamp is on.');
            },
        ],
    });
    const running = receive(agent, db, { userId: 7, messageId: 'm1', name: 'Alex', text: 'lamp on' });
    await waitFor(() => sentToMax(agent).some(m => m.keyboard), 'the question with buttons');
    const question = sentToMax(agent).find(m => m.keyboard);
    assert.equal(question.userId, '7');
    assert.match(question.text, /x\.0\.lamp/);
    const [yes, no] = question.keyboard[0].map(b => b.callback);
    assert.match(yes, /^pi-agent:yes:[0-9a-f]+$/);
    assert.match(no, /^pi-agent:no:[0-9a-f]+$/);
    assert.deepEqual(db.writes, [], 'nothing written before the answer');

    // an outdated button is dropped, the right one is answered with answerCallback
    await receive(agent, db, { userId: 7, messageId: 'm2', name: 'Alex', text: 'pi-agent:yes:00000000' });
    await receive(agent, db, { userId: 7, messageId: 'm3', name: 'Alex', text: yes });
    await running;
    assert.deepEqual(db.writes, [['x.0.lamp', true]]);
    assert.deepEqual(
        sentToMax(agent).filter(m => m.command === 'answerCallback'),
        [{ command: 'answerCallback', userId: 7, text: '✅' }],
    );
    assert.deepEqual(sentToMax(agent).at(-1), { command: 'send', userId: '7', text: 'Lamp is on.' });
    assert.doesNotMatch(seen[0], /pi-agent:yes/, 'the button payload never reaches the model');
    await stopAgent(agent);
});

test('MAX and Telegram side by side: each answer goes back through its own bot', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { messengers: [...CONFIG.messengers, { enabled: true, instance: 'telegram.0', users: '1', prefix: '' }] },
        seed: knownUser,
        responses: [f.fauxAssistantMessage('via MAX'), f.fauxAssistantMessage('via Telegram')],
    });
    await receive(agent, db, { userId: 7, messageId: 'm1', name: 'Alex', text: 'hi' });
    const ts = Date.now();
    db.setState('telegram.0.communicate.requestChatId', { val: 100, ack: true, ts });
    db.setState('telegram.0.communicate.requestUserId', { val: 1, ack: true, ts });
    db.setState('telegram.0.communicate.requestMessageId', { val: 1, ack: true, ts });
    await agent.onStateChange('telegram.0.communicate.request', { val: '[Alex]hi', ack: true, ts });
    assert.deepEqual(sentToMax(agent), [{ command: 'send', userId: '7', text: 'via MAX' }]);
    assert.deepEqual(
        agent.sent.filter(([to]) => to === 'telegram.0').map(([, , m]) => m),
        [{ text: 'via Telegram', chatId: '100', parse_mode: 'HTML' }],
    );
    await stopAgent(agent);
});

test('a messenger without a driver is ignored with a warning', async () => {
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { messengers: [{ enabled: true, instance: 'whatsapp-cmb.0', users: '1', prefix: '' }] },
        responses: [],
    });
    assert.equal(agent.foreignSubscriptions, undefined);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('whatsapp-cmb.0 ignored')));
    await stopAgent(agent);
});

test('markdownToPlain removes the Markdown marks and keeps the link target', () => {
    assert.equal(
        markdownToPlain('# Title\n**bold** and __bold__, `code`, [docs](https://x.y/z)\n```js\nlet a;\n```'),
        'Title\nbold and bold, code, docs (https://x.y/z)\nlet a;\n',
    );
});

test('MAX: a voice message (max 0.1.13 writes communicate.pathFile) is recognized and answered to the user', async () => {
    const f = await faux();
    const seen = [];
    const dataDir = tmp();
    const { agent, db } = await startAgent({
        dataDir,
        config: { ...CONFIG, speechService: 'server', speechBaseUrl: 'http://nas:8000/v1', speechModel: 'm' },
        seed: knownUser,
        responses: [
            context => {
                seen.push(JSON.stringify(context));
                return f.fauxAssistantMessage('Done');
            },
        ],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${MAX}.communicate.request`, `${MAX}.communicate.pathFile`]);
    agent.fetch = async (url, init) => {
        assert.equal(init.body.get('file').name, 'mid-1.m4a');
        return new Response(JSON.stringify({ text: 'lights off' }), { status: 200 });
    };
    // max writes forward slashes on every platform: <data>/max_0/voice/<mid>.<ext>
    fs.mkdirSync(path.join(dataDir, 'max_0', 'voice'), { recursive: true });
    const file = path.join(dataDir, 'max_0', 'voice', 'mid-1.m4a');
    fs.writeFileSync(file, 'm4a');
    const ts = Date.now();
    db.setState(`${MAX}.communicate.requestChatId`, { val: 0, ack: true, ts });
    db.setState(`${MAX}.communicate.requestUserId`, { val: 7, ack: true, ts });
    db.setState(`${MAX}.communicate.requestMessageId`, { val: 'mid-1', ack: true, ts });
    await agent.onStateChange(`${MAX}.communicate.pathFile`, { val: file.split(path.sep).join('/'), ack: true, ts });
    assert.deepEqual(sentToMax(agent), [
        { command: 'send', userId: '7', text: '🎤 «lights off»' },
        { command: 'send', userId: '7', text: 'Done' },
    ]);
    assert.match(seen[0], /🎤 lights off/);
    assert.match(seen[0], /voice message turned into text/);
    await stopAgent(agent);
});
