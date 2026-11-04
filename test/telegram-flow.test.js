'use strict';

// The Telegram path of main.js against a stand-in telegram.0: who may talk, the prefix, one conversation
// per chat, a message delivered twice, and a restart in the middle of a Telegram request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-tg-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const TG = 'telegram.0';
const CONFIG = { messengers: [{ enabled: true, instance: TG, users: '1, @bob', prefix: '/ai' }] };
const USERS = JSON.stringify({ 1: { firstName: 'Alex', userName: 'alex' }, 2: { firstName: 'Bob', userName: 'bob' } });

/** Let a stand-in telegram instance receive a message, like the telegram adapter writes it. */
async function receive(agent, db, { chatId, userId, messageId, name, text }, instance = TG) {
    const ts = Date.now();
    db.setState(`${instance}.communicate.requestChatId`, { val: chatId, ack: true, ts });
    db.setState(`${instance}.communicate.requestUserId`, { val: userId, ack: true, ts });
    db.setState(`${instance}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    db.setState(`${instance}.communicate.users`, { val: USERS, ack: true, ts });
    await agent.onStateChange(`${instance}.communicate.request`, { val: `[${name}]${text}`, ack: true, ts });
}

const sentToTelegram = (agent, instance = TG) => agent.sent.filter(([to]) => to === instance).map(([, , msg]) => msg);

test('only allowed users with the prefix reach the agent; each chat has its own conversation', async () => {
    const f = await faux();
    const seen = [];
    const answer = reply => context => {
        seen.push(JSON.stringify(context));
        return f.fauxAssistantMessage(reply);
    };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [answer('Hello Alex'), answer('Hello Bob')],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${TG}.communicate.request`]);

    // not allowed: ignored with a warning, nothing sent
    await receive(agent, db, { chatId: 300, userId: 3, messageId: 1, name: 'Eve', text: '/ai open the door' });
    // allowed but without prefix: not for the agent
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 2, name: 'Alex', text: 'hello bot' });
    assert.deepEqual(sentToTelegram(agent), []);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('Eve (3) ignored')));

    await receive(agent, db, { chatId: 100, userId: 1, messageId: 3, name: 'Alex', text: '/ai I am Alex' });
    await receive(agent, db, { chatId: 200, userId: 2, messageId: 4, name: 'Bob', text: '/ai I am Bob' });

    assert.deepEqual(sentToTelegram(agent), [
        { text: 'Hello Alex', chatId: '100', parse_mode: 'HTML' },
        { text: 'Hello Bob', chatId: '200', parse_mode: 'HTML' },
    ]);
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), [`${TG}/100`, `${TG}/200`]);
    assert.notEqual(chats[`${TG}/100`], chats[`${TG}/200`], 'two chats, two conversations');
    assert.match(seen[1], /I am Bob/);
    assert.doesNotMatch(seen[1], /I am Alex/, "Bob's conversation does not see Alex's messages");
    assert.match(seen[0], /This conversation is a Telegram chat/, 'chats get the Telegram instructions');
    assert.equal(db.states[`${NAMESPACE}.chat.answer`], undefined, 'Telegram answers do not go to chat.answer');
    await stopAgent(agent);
});

test('the first name from the telegram user list is accepted, like in other adapters', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { messengers: [{ ...CONFIG.messengers[0], users: 'Alex' }] },
        responses: [f.fauxAssistantMessage('Hi Alex')],
    });
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 11, name: 'Alex', text: '/ai hi' });
    assert.deepEqual(sentToTelegram(agent), [{ text: 'Hi Alex', chatId: '100', parse_mode: 'HTML' }]);

    // somebody unknown to telegram.0 who calls himself Alex is still refused
    await receive(agent, db, { chatId: 400, userId: 4, messageId: 12, name: 'Alex', text: '/ai open the door' });
    assert.equal(sentToTelegram(agent).length, 1);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('(4) ignored')));
    await stopAgent(agent);
});

test('a message delivered twice runs the model once', async () => {
    const f = await faux();
    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [f.fauxAssistantMessage('Once'), f.fauxAssistantMessage('Twice?')],
    });
    const message = { chatId: 100, userId: 1, messageId: 7, name: 'Alex', text: '/ai hi' };
    await receive(agent, db, message);
    await receive(agent, db, message);
    assert.equal(provider.state.callCount, 1);
    assert.ok(sentToTelegram(agent).every(m => m.text === 'Once'));
    await stopAgent(agent);
});

test('a restart in the middle of a Telegram request answers in the same chat afterwards', async () => {
    const f = await faux();
    const dataDir = tmp();
    let entered = false;
    let release;
    const gate = new Promise(r => (release = r));
    const first = await startAgent({
        dataDir,
        config: CONFIG,
        seed: CRASH_SEED,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_state', { id: 'x.0.lamp' }), { stopReason: 'toolUse' }),
        ],
        hooks: {
            getForeignState: async () => {
                entered = true;
                await gate;
            },
        },
    });
    const running = receive(first.agent, first.db, {
        chatId: 100,
        userId: 1,
        messageId: 9,
        name: 'Alex',
        text: '/ai is the lamp on?',
    });
    await waitFor(() => entered, 'the tool call to start');
    const stopped = stopAgent(first.agent);
    release();
    await stopped;
    await running;
    assert.deepEqual(sentToTelegram(first.agent), [], 'no error message to the chat on shutdown');
    assert.match(first.db.states[`${NAMESPACE}.chat.pending`].val, /"chatId":"100"/);

    const second = await startAgent({
        dataDir,
        config: CONFIG,
        responses: [f.fauxAssistantMessage('The lamp is off.'), f.fauxAssistantMessage('The lamp is off.')],
    });
    await waitFor(() => second.db.states[`${NAMESPACE}.chat.pending`].val === '', 'the resumed request to finish');
    assert.deepEqual(sentToTelegram(second.agent), [{ text: 'The lamp is off.', chatId: '100', parse_mode: 'HTML' }]);
    await stopAgent(second.agent);
});

test('Telegram is off when no instance is configured', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), responses: [] });
    assert.equal(agent.foreignSubscriptions, undefined);
    await stopAgent(agent);
});

test('a telegram instance that also hands messages to assistant or text2command gets a warning', async () => {
    const instance = native => ({ type: 'instance', common: { name: 'telegram' }, native });
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: {
            messengers: [
                { enabled: true, instance: TG, users: '1' },
                { enabled: true, instance: 'telegram.1', users: '1' },
            ],
        },
        seed: {
            objects: {
                [`system.adapter.${TG}`]: instance({ assistantInstance: 'assistant.0', text2command: '' }),
                'system.adapter.telegram.1': instance({ assistantInstance: '', text2command: '' }),
            },
        },
        responses: [],
    });
    const warnings = agent.logs.filter(([lvl, m]) => lvl === 'warn' && m.includes('two answers'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][1], /telegram\.0 also hands messages to assistant\.0 \("assistant instance"/);
    await stopAgent(agent);
});

test('Markdown in an answer is sent as Telegram HTML', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [f.fauxAssistantMessage('**Чтение** — всё, a<b')],
    });
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 21, name: 'Alex', text: '/ai what can you do?' });
    assert.deepEqual(sentToTelegram(agent), [
        { text: '<b>Чтение</b> — всё, a&lt;b', chatId: '100', parse_mode: 'HTML' },
    ]);
    await stopAgent(agent);
});

test('chats do not wait for each other: a slow request in one chat does not block another chat', async () => {
    const f = await faux();
    let release;
    const gate = new Promise(r => (release = r));
    let entered = false;
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        seed: CRASH_SEED,
        responses: [
            // chat 100 calls a tool that hangs until released
            f.fauxAssistantMessage(f.fauxToolCall('get_state', { id: 'x.0.lamp' }), { stopReason: 'toolUse' }),
            // chat 200 is answered while chat 100 still waits
            f.fauxAssistantMessage('Bob first'),
            f.fauxAssistantMessage('Alex later'),
        ],
        hooks: {
            getForeignState: async () => {
                entered = true;
                await gate;
            },
        },
    });
    const slow = receive(agent, db, { chatId: 100, userId: 1, messageId: 31, name: 'Alex', text: '/ai lamp?' });
    await waitFor(() => entered, 'the slow tool call');
    await receive(agent, db, { chatId: 200, userId: 2, messageId: 32, name: 'Bob', text: '/ai hi' });
    assert.deepEqual(sentToTelegram(agent), [{ text: 'Bob first', chatId: '200', parse_mode: 'HTML' }]);
    release();
    await slow;
    assert.deepEqual(sentToTelegram(agent)[1], { text: 'Alex later', chatId: '100', parse_mode: 'HTML' });
    await stopAgent(agent);
});

test('an answer that would give broken HTML goes out as plain text, with a warning', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [f.fauxAssistantMessage('**fett *kursiv** text*')],
    });
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 41, name: 'Alex', text: '/ai format' });
    assert.deepEqual(sentToTelegram(agent), [{ text: '**fett *kursiv** text*', chatId: '100' }]);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('sent as plain text')));
    await stopAgent(agent);
});

test('two Telegram instances: each has its users and prefix, answers go back through the bot they came from', async () => {
    const f = await faux();
    const TG2 = 'telegram.1';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: {
            messengers: [
                ...CONFIG.messengers,
                { enabled: true, instance: TG2, users: '2', prefix: '' },
                { enabled: false, instance: 'telegram.2', users: '1', prefix: '' },
            ],
        },
        responses: [f.fauxAssistantMessage('via bot 0'), f.fauxAssistantMessage('via bot 1')],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${TG}.communicate.request`, `${TG2}.communicate.request`]);

    // Alex is allowed on telegram.0 only; on telegram.1 no prefix is needed
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 5, name: 'Alex', text: 'hi' }, TG2);
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 5, name: 'Alex', text: '/ai hi' });
    await receive(agent, db, { chatId: 100, userId: 2, messageId: 5, name: 'Bob', text: 'hi' }, TG2);
    assert.deepEqual(sentToTelegram(agent), [{ text: 'via bot 0', chatId: '100', parse_mode: 'HTML' }]);
    assert.deepEqual(sentToTelegram(agent, TG2), [{ text: 'via bot 1', chatId: '100', parse_mode: 'HTML' }]);

    // same chat id and message id on both bots: two requests, two conversations
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), [`${TG}/100`, `${TG2}/100`]);
    assert.notEqual(chats[`${TG}/100`], chats[`${TG2}/100`]);
    await stopAgent(agent);
});

test('settings of 0.0.5 (one instance in single fields) move into the table and the instance restarts', async () => {
    const id = `system.adapter.${NAMESPACE}`;
    const legacy = { telegramInstance: TG, telegramUsers: '1\n@bob', telegramPrefix: '/ai' };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: legacy,
        seed: { objects: { [id]: { type: 'instance', common: {}, native: { ...legacy, apiKey: 'x' } } } },
        responses: [],
    });
    assert.deepEqual(db.objects[id].native, {
        apiKey: 'x',
        messengers: [{ enabled: true, instance: TG, users: '1\n@bob', prefix: '/ai' }],
        telegramInstance: '',
        telegramUsers: '',
        telegramPrefix: '',
    });
    assert.equal(agent.harness, null, 'the agent waits for the restart');
    await stopAgent(agent);
});

test('chats and pending requests of 0.0.5 (keys without instance) belong to the first instance', async () => {
    const f = await faux();
    const dataDir = tmp();
    // a first run creates the conversation of chat 100
    const first = await startAgent({ dataDir, config: CONFIG, responses: [f.fauxAssistantMessage('first')] });
    await receive(first.agent, first.db, { chatId: 100, userId: 1, messageId: 1, name: 'Alex', text: '/ai hi' });
    await stopAgent(first.agent);
    // ... then the stored data is turned back into the format of 0.0.5
    const db = first.db;
    const conversation = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val)[`${TG}/100`];
    db.setState(`${NAMESPACE}.telegram.chats`, { val: JSON.stringify({ 100: conversation }), ack: true });
    const pending = [{ requestId: 'tg-100-2', content: 'still there?', target: { kind: 'telegram', chatId: '100' } }];
    db.setState(`${NAMESPACE}.chat.pending`, { val: JSON.stringify(pending), ack: true });

    const second = await startAgent({ dataDir, config: CONFIG, responses: [f.fauxAssistantMessage('yes')] });
    await waitFor(() => second.db.states[`${NAMESPACE}.chat.pending`].val === '', 'the resumed request to finish');
    assert.deepEqual(JSON.parse(second.db.states[`${NAMESPACE}.telegram.chats`].val), { [`${TG}/100`]: conversation });
    assert.deepEqual(sentToTelegram(second.agent), [{ text: 'yes', chatId: '100', parse_mode: 'HTML' }]);
    await stopAgent(second.agent);
});

test('sendTo "listMessengerInstances" lists the installed telegram and max instances for the table', async () => {
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: {
            objects: {
                'system.adapter.telegram.0': { type: 'instance', common: { title: 'Telegram' } },
                'system.adapter.telegram.1': { type: 'instance', common: {} },
                'system.adapter.telegramm.0': { type: 'instance', common: {} },
                'system.adapter.max.0': { type: 'instance', common: { titleLang: { en: 'MAX Messenger Bot' } } },
            },
        },
        responses: [],
    });
    const answer = await new Promise(resolve => {
        agent.sendTo = (to, command, options) => resolve(options);
        agent.onMessage({ command: 'listMessengerInstances', from: 'system.adapter.admin.0', callback: {} });
    });
    assert.deepEqual(answer, [
        { value: 'telegram.0', label: 'telegram.0 (Telegram)' },
        { value: 'telegram.1', label: 'telegram.1' },
        { value: 'max.0', label: 'max.0 (MAX Messenger Bot)' },
    ]);
    await stopAgent(agent);
});

test('a voice message is recognized, shown in the chat and answered; refused senders and photos are not', async () => {
    const f = await faux();
    const seen = [];
    const dataDir = tmp();
    const { agent, db } = await startAgent({
        dataDir,
        config: {
            ...CONFIG,
            speechService: 'server',
            speechBaseUrl: 'http://nas:8000/v1',
            speechModel: 'Systran/faster-whisper-small',
        },
        responses: [
            context => {
                seen.push(JSON.stringify(context));
                return f.fauxAssistantMessage('The light is off');
            },
        ],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${TG}.communicate.request`, `${TG}.communicate.pathFile`]);
    const posted = [];
    agent.fetch = async (url, init) => {
        posted.push({ url, file: init.body.get('file'), model: init.body.get('model') });
        return new Response(JSON.stringify({ text: 'switch the light off' }), { status: 200 });
    };
    fs.mkdirSync(path.join(dataDir, 'voice'));
    const voice = path.join(dataDir, 'voice', 'temp.ogg');
    fs.writeFileSync(voice, 'OggS fake opus');
    const deliver = async (userId, messageId, file = voice) => {
        const ts = Date.now();
        db.setState(`${TG}.communicate.requestChatId`, { val: 100, ack: true, ts });
        db.setState(`${TG}.communicate.requestUserId`, { val: userId, ack: true, ts });
        db.setState(`${TG}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
        db.setState(`${TG}.communicate.users`, { val: USERS, ack: true, ts });
        await agent.onStateChange(`${TG}.communicate.pathFile`, { val: file, ack: true, ts });
    };

    await deliver(3, 20); // not allowed
    await deliver(1, 21, path.join(dataDir, 'photo', 'p.jpg')); // a photo, not a voice message
    assert.deepEqual(posted, []);
    assert.deepEqual(sentToTelegram(agent), []);

    await deliver(1, 22);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'http://nas:8000/v1/audio/transcriptions');
    assert.equal(posted[0].model, 'Systran/faster-whisper-small');
    assert.equal(posted[0].file.name, 'temp.ogg');
    assert.deepEqual(sentToTelegram(agent), [
        { text: '🎤 «switch the light off»', chatId: '100', parse_mode: 'HTML' },
        { text: 'The light is off', chatId: '100', parse_mode: 'HTML' },
    ]);
    assert.match(seen[0], /🎤 switch the light off/, 'the model gets the text marked as a voice message');
    assert.match(seen[0], /voice message turned into text/, 'and the instruction how to read it');
    await stopAgent(agent);
});

test('a failed speech recognition is reported in the chat; "Voice" off or no service: no subscription', async () => {
    const dataDir = tmp();
    const speech = { speechService: 'server', speechBaseUrl: 'http://nas:8000/v1', speechModel: 'm' };
    const { agent, db } = await startAgent({ dataDir, config: { ...CONFIG, ...speech }, responses: [] });
    agent.fetch = async () =>
        new Response(JSON.stringify({ detail: "Model 'm' is not installed locally" }), { status: 404 });
    fs.mkdirSync(path.join(dataDir, 'voice'));
    const voice = path.join(dataDir, 'voice', 'temp.ogg');
    fs.writeFileSync(voice, 'OggS');
    db.setState(`${TG}.communicate.requestChatId`, { val: 100, ack: true });
    db.setState(`${TG}.communicate.requestUserId`, { val: 1, ack: true });
    db.setState(`${TG}.communicate.requestMessageId`, { val: 30, ack: true });
    db.setState(`${TG}.communicate.users`, { val: USERS, ack: true });
    await agent.onStateChange(`${TG}.communicate.pathFile`, { val: voice, ack: true, ts: Date.now() });
    assert.deepEqual(sentToTelegram(agent), [
        {
            text: "🎤 Speech recognition failed: HTTP 404: Model 'm' is not installed locally",
            chatId: '100',
            parse_mode: 'HTML',
        },
    ]);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('speech recognition failed')));
    await stopAgent(agent);

    for (const config of [
        { messengers: [{ ...CONFIG.messengers[0], voice: false }], ...speech },
        { ...CONFIG, speechService: '' },
    ]) {
        const other = await startAgent({ dataDir: tmp(), config, responses: [] });
        assert.deepEqual(other.agent.foreignSubscriptions, [`${TG}.communicate.request`]);
        await stopAgent(other.agent);
    }
});

test('sendTo "testSpeech" checks the unsaved form; OpenRouter without any key says where to enter one', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), config: { provider: 'deepseek', apiKey: 'x' }, responses: [] });
    const ask = message =>
        new Promise(resolve => {
            agent.sendTo = (to, command, answer) => resolve(answer);
            agent.onMessage({ command: 'testSpeech', from: 'system.adapter.admin.0', callback: {}, message });
        });
    agent.fetch = async (url, init) => {
        assert.equal(init.body.get('file').name, 'test.wav');
        return new Response(JSON.stringify({ text: '' }), { status: 200 });
    };
    const ok = await ask({ speechService: 'server', speechBaseUrl: 'http://nas:8000/v1', speechModel: 'm' });
    assert.match(ok.result, /^OK: m answered in \d+\.\d s$/);
    const noKey = await ask({ speechService: 'openrouter' });
    assert.match(noKey.error, /no OpenRouter key/);
    const noUrl = await ask({ speechService: 'server', speechModel: 'm' });
    assert.match(noUrl.error, /no server URL/);
    await stopAgent(agent);
});
