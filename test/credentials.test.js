'use strict';

// The API key from the instance or from the central credential store of admin 8, and the start with an
// OpenAI-compatible server, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, NAMESPACE } = require('./helpers/agent-harness');
const { keySourceOf, resolveApiKey } = require('../lib/credentials');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-cred-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const CREDENTIAL = 'system.credentials.deepseek';

/** A credential object as admin 8 stores it; the fake adapter "decrypts" by removing "enc:". */
const credentialObject = key => ({
    _id: CREDENTIAL,
    type: 'config',
    common: { name: 'DeepSeek' },
    native: { type: 'ai', version: 1, encryptedFields: ['key'], key: `enc:${key}` },
});

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer, callback) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({ command, message, from: 'system.adapter.admin.0', callback: { id: 1 } });
    });
}

test('keySourceOf: only "central" is the central store', () => {
    assert.equal(keySourceOf({ keySource: 'central' }), 'central');
    assert.equal(keySourceOf({ keySource: 'adapter' }), 'adapter');
    assert.equal(keySourceOf({}), 'adapter');
});

test('resolveApiKey: the field of the instance, or the decrypted key of the chosen credential', async () => {
    const adapter = {
        getForeignObjectAsync: async id => (id === CREDENTIAL ? credentialObject('sk-central') : null),
        decrypt: value => value.replace(/^enc:/, ''),
    };
    assert.equal(await resolveApiKey(adapter, { apiKey: ' sk-local ' }), 'sk-local');
    assert.equal(
        await resolveApiKey(adapter, { keySource: 'central', apiKey: 'x', credentialId: CREDENTIAL }),
        'sk-central',
    );
    assert.equal(await resolveApiKey(adapter, { keySource: 'central', credentialId: '' }), '');
    await assert.rejects(
        resolveApiKey(adapter, { keySource: 'central', credentialId: 'system.credentials.gone' }),
        /not found/,
    );
});

test('central key: the agent starts with the key of the credential and restarts when it changes', async () => {
    const f = await faux();
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { provider: 'deepseek', apiKey: '', keySource: 'central', credentialId: CREDENTIAL },
        seed: { objects: { [CREDENTIAL]: credentialObject('sk-central') } },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0][1], 'sk-central');
    assert.deepEqual(
        agent.objectSubscriptions.filter(id => !id.startsWith('system.adapter.')),
        [CREDENTIAL],
    );
    assert.equal(agent.db.states[`${NAMESPACE}.info.connection`].val, true);

    agent.emit('objectChange', 'system.credentials.other', credentialObject('x'));
    assert.equal(agent.restarted, undefined, 'another credential does not matter');
    agent.emit('objectChange', CREDENTIAL, credentialObject('sk-new'));
    assert.equal(agent.restarted, 1);
    await stopAgent(agent);
});

test('central key: a missing credential keeps the agent idle with a warning', async () => {
    const f = await faux();
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: {
            provider: 'deepseek',
            apiKey: 'ignored',
            keySource: 'central',
            credentialId: 'system.credentials.gone',
        },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls.length, 0);
    assert.ok(agent.logs.some(([level, msg]) => level === 'warn' && msg.includes('system.credentials.gone')));
    assert.equal(agent.db.states[`${NAMESPACE}.info.connection`].val, false);
    await stopAgent(agent);
});

test('OpenAI-compatible server: starts without a key, with base URL and model', async () => {
    const f = await faux();
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { provider: 'custom', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3:8b' },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.deepEqual(providerCalls[0], ['custom', '', { baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3:8b' }]);
    await stopAgent(agent);
});

test('OpenAI-compatible server: without a model the start fails with a clear message', async () => {
    const f = await faux();
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { provider: 'custom', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1', modelId: '' },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls.length, 0);
    assert.ok(agent.logs.some(([level, msg]) => level === 'error' && msg.includes('No model configured')));
    await stopAgent(agent);
});

test('Test connection: the form values are checked before anything is sent', async () => {
    const f = await faux();
    const { agent } = await startAgent({ dataDir: tmp(), responses: [f.fauxAssistantMessage('hi')] });
    assert.deepEqual(await call(agent, 'testConnection', { provider: 'openai', keySource: 'adapter', apiKey: '' }), {
        error: 'No API key entered',
    });
    assert.deepEqual(
        await call(agent, 'testConnection', { provider: 'openai', keySource: 'central', credentialId: '' }),
        { error: 'No credential chosen' },
    );
    assert.deepEqual(
        await call(agent, 'testConnection', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', modelId: '' }),
        { error: 'No model entered' },
    );
    await stopAgent(agent);
});

test('the unused setting "telegramChannels" of a development build is removed once', async () => {
    const f = await faux();
    const id = `system.adapter.${NAMESPACE}`;
    const { agent, providerCalls, db } = await startAgent({
        dataDir: tmp(),
        config: { telegramChannels: [{ instance: 'telegram.0' }] },
        seed: {
            objects: {
                [id]: { _id: id, type: 'instance', common: {}, native: { telegramChannels: [], apiKey: 'test' } },
            },
        },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls.length, 0, 'js-controller restarts the instance');
    // a partial update of the instance object, like js-controller merges it: the key stays as null
    assert.deepEqual(db.objects[id].native, { telegramChannels: null, apiKey: 'test' });
    await stopAgent(agent);
});
