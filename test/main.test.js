'use strict';

// Lifecycle tests of main.js: start, requests, shutdown in the middle of a run, and a hard crash
// during a write. The real harness and JSONL store run; only adapter-core and the model are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED, CRASH_CONFIG } = require('./helpers/crash-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-test-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const state = (db, id) => db.states[`${NAMESPACE}.${id}`];

test('without an API key the agent warns, stays idle and refuses requests', async () => {
    const { agent, db } = await startAgent({ dataDir: tmp(), config: { apiKey: '' }, responses: [] });
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.startsWith('No API key configured')));
    assert.ok(!agent.logs.some(([lvl]) => lvl === 'error'), JSON.stringify(agent.logs));
    assert.equal(state(db, 'info.connection').val, false);

    await agent.onMessage({ command: 'ask', message: { text: 'hi' }, from: 'x', callback: 'cb' });
    assert.deepEqual(agent.sent[0][2], { error: 'Agent is not running' });
    await stopAgent(agent);
});

test('a request in chat.input is answered once, then input is acknowledged and pending cleared', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({ dataDir: tmp(), responses: [f.fauxAssistantMessage('Hello there')] });
    assert.equal(state(db, 'info.connection').val, true);

    await agent.onStateChange(`${NAMESPACE}.chat.input`, { val: 'Hi', ack: false, ts: 42 });
    assert.equal(state(db, 'chat.answer').val, 'Hello there');
    assert.equal(state(db, 'chat.pending').val, '');
    assert.equal(state(db, 'chat.input').ack, true);
    await stopAgent(agent);
});

test('sendTo "ask" answers through the callback', async () => {
    const f = await faux();
    const { agent } = await startAgent({ dataDir: tmp(), responses: [f.fauxAssistantMessage('Via sendTo')] });
    await agent.onMessage({ command: 'ask', message: { text: 'Hi' }, from: 'javascript.0', callback: 'cb' });
    assert.deepEqual(agent.sent[0], ['javascript.0', 'ask', { answer: 'Via sendTo' }, 'cb']);
    await stopAgent(agent);
});

test('a shutdown in the middle of a run is no error, and the next start finishes the request', async () => {
    const f = await faux();
    const dataDir = tmp();
    let entered = false;
    let release;
    const gate = new Promise(r => (release = r));
    let reads = 0;
    const first = await startAgent({
        dataDir,
        seed: CRASH_SEED,
        responses: [f.fauxAssistantMessage(f.fauxToolCall('get_state', { id: 'x.0.lamp' }), { stopReason: 'toolUse' })],
        hooks: {
            getForeignState: async () => {
                reads++;
                entered = true;
                await gate;
            },
        },
    });
    const running = first.agent.onStateChange(`${NAMESPACE}.chat.input`, { val: 'Is the lamp on?', ack: false, ts: 7 });
    await waitFor(() => entered, 'the tool call to start');

    const stopped = stopAgent(first.agent);
    release();
    await stopped;
    await running;

    assert.equal(state(first.db, 'chat.answer'), undefined, 'no error answer on shutdown');
    assert.match(state(first.db, 'chat.pending').val, /Is the lamp on\?/, 'pending survives the shutdown');
    assert.ok(!first.agent.logs.some(([lvl]) => lvl === 'error'), JSON.stringify(first.agent.logs));
    assert.ok(first.agent.logs.some(([, m]) => m.startsWith('Request interrupted by shutdown')));

    const second = await startAgent({
        dataDir,
        responses: [f.fauxAssistantMessage('The lamp is off.'), f.fauxAssistantMessage('The lamp is off.')],
        hooks: { getForeignState: async () => reads++ },
    });
    await waitFor(() => state(second.db, 'chat.pending').val === '', 'the resumed request to finish');
    assert.equal(state(second.db, 'chat.answer').val, 'The lamp is off.');
    assert.ok(second.agent.logs.some(([, m]) => /^Continuing request chat-/.test(m)));
    assert.ok(reads <= 2, `get_state ran ${reads} times`);
    await stopAgent(second.agent);
});

test('a crash during set_state: the write is not repeated and the model is told it was interrupted', async () => {
    const f = await faux();
    const dataDir = tmp();
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'crash-child.js'), dataDir], {
        encoding: 'utf8',
        timeout: 60000,
    });
    assert.equal(child.status, 137, `child ended with ${child.status}: ${child.stderr}`);

    let seenByModel = '';
    const second = await startAgent({
        dataDir,
        config: CRASH_CONFIG,
        responses: [
            context => {
                seenByModel = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('The lamp is on now, I checked it.');
            },
        ],
    });
    await waitFor(() => state(second.db, 'chat.pending').val === '', 'the resumed request to finish');

    assert.deepEqual(second.db.writes, [['x.0.lamp', true]], 'exactly one write, the one before the crash');
    assert.match(seenByModel, /interrupted/i, 'the model learns that the write was interrupted');
    assert.equal(state(second.db, 'chat.answer').val, 'The lamp is on now, I checked it.');
    await stopAgent(second.agent);
});

test('own objects are created with translated names; an ACL set by the user survives the start', async () => {
    const dataDir = tmp();
    const userAcl = {
        owner: 'system.user.mcp-user',
        ownerGroup: 'system.group.administrator',
        object: 1636,
        state: 1636,
    };
    const { agent, db } = await startAgent({
        dataDir,
        config: { apiKey: '' },
        responses: [],
        seed: {
            // chat.input as an earlier version left it: English name, and an owner the user changed
            objects: {
                [`${NAMESPACE}.chat.input`]: {
                    type: 'state',
                    common: { name: 'Request to the agent', type: 'string', role: 'text', read: true, write: true },
                    acl: userAcl,
                },
            },
        },
    });
    const input = db.objects[`${NAMESPACE}.chat.input`];
    assert.deepEqual(input.acl, userAcl, 'the ACL is untouched');
    assert.equal(input.common.name.ru, 'Запрос к агенту', 'the name is updated');
    for (const id of ['chat', 'chat.answer', 'chat.pending', 'telegram', 'telegram.chats']) {
        assert.equal(Object.keys(db.objects[`${NAMESPACE}.${id}`].common.name).length, 11, id);
    }
    await stopAgent(agent);
});

test('the model field of the admin page lists the catalog models of the chosen provider, also without API key', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), config: { apiKey: '' }, responses: [] });
    const ask = async provider => {
        agent.sent.length = 0;
        await agent.onMessage({ command: 'listModels', message: { provider }, from: 'admin.0', callback: 'cb' });
        const [to, command, options, callback] = agent.sent[0];
        assert.deepEqual([to, command, callback], ['admin.0', 'listModels', 'cb']);
        return options;
    };
    const deepseek = await ask('deepseek');
    assert.deepEqual(deepseek[0], { value: '', label: 'Default (deepseek-flash)', noTranslation: true });
    assert.ok(
        deepseek.some(o => o.value === 'deepseek-v4-pro'),
        JSON.stringify(deepseek),
    );
    const anthropic = await ask('anthropic');
    assert.equal(anthropic[0].label, 'Default (claude-sonnet-5-5)');
    assert.ok(!anthropic.some(o => o.value.startsWith('deepseek')), 'switching the provider switches the list');
    assert.deepEqual(await ask('nope'), [], 'an unknown provider gives an empty list, not an error');
    await stopAgent(agent);
});

test('an outdated "supportedMessages" of 0.0.1-0.0.4 is removed from the instance object once', async () => {
    const dataDir = tmp();
    const instanceId = `system.adapter.${NAMESPACE}`;
    const first = await startAgent({
        dataDir,
        responses: [],
        seed: {
            objects: {
                [instanceId]: {
                    type: 'instance',
                    common: { messagebox: true, supportedMessages: { custom: false } },
                    native: { apiKey: 'kept-as-stored' },
                },
            },
        },
    });
    const migrated = first.db.objects[instanceId];
    assert.equal(migrated.common.supportedMessages, null, 'a partial update; js-controller takes null as absent');
    assert.equal(migrated.common.messagebox, true);
    assert.equal(migrated.native.apiKey, 'kept-as-stored', 'the rest of the object is kept');
    assert.ok(first.agent.logs.some(([, m]) => m.startsWith('Message box enabled')));
    assert.equal(first.db.states[`${NAMESPACE}.info.connection`].val, false, 'no agent start before the restart');
    await stopAgent(first.agent);

    // after the restart: nothing to do any more, the agent starts normally
    const second = await startAgent({ dataDir, responses: [] });
    assert.ok(!second.agent.logs.some(([, m]) => m.startsWith('Message box enabled')));
    assert.equal(second.db.states[`${NAMESPACE}.info.connection`].val, true);
    assert.equal(second.agent.listenerCount('objectChange'), 1, 'one handler for all watched objects');
    await stopAgent(second.agent);
});

test('a "supportedMessages" with a true value is left alone', async () => {
    const instanceId = `system.adapter.${NAMESPACE}`;
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        responses: [],
        seed: { objects: { [instanceId]: { type: 'instance', common: { supportedMessages: { custom: true } } } } },
    });
    assert.deepEqual(db.objects[instanceId].common.supportedMessages, { custom: true });
    await stopAgent(agent);
});
