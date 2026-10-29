'use strict';

// The system-wide AI settings of admin (system.ai) as key source, and conversations of sendTo callers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, NAMESPACE } = require('./helpers/agent-harness');
const { keySourceOf, usesSystemAi, systemAiForm, systemAiFingerprint } = require('../lib/credentials');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-system-ai-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const CREDENTIAL = 'system.credentials.anthropic';

const credentialObject = key => ({
    _id: CREDENTIAL,
    type: 'config',
    common: { name: 'Anthropic' },
    native: { type: 'ai', version: 1, encryptedFields: ['key'], key: `enc:${key}` },
});

/** system.ai as the AI tab of the admin system settings stores it. */
const systemAi = native => ({ _id: 'system.ai', type: 'config', common: { name: 'AI' }, native });

test('keySourceOf / usesSystemAi: explicit "system", or an instance without any provider of its own', () => {
    assert.equal(keySourceOf({ keySource: 'system' }), 'system');
    assert.equal(keySourceOf({ keySource: 'whatever' }), 'adapter');
    assert.equal(usesSystemAi({ keySource: 'system', apiKey: 'sk' }), true);
    assert.equal(usesSystemAi({ keySource: 'adapter', apiKey: '', provider: 'openai' }), true, 'nothing configured');
    assert.equal(usesSystemAi({ keySource: 'adapter', apiKey: 'sk', provider: 'openai' }), false);
    assert.equal(usesSystemAi({ keySource: 'adapter', apiKey: '', provider: 'custom' }), false, 'keyless server');
    assert.equal(usesSystemAi({ keySource: 'central', credentialId: '' }), false, 'an explicit choice');
});

test('every provider of system.ai maps to a provider this adapter can load', async () => {
    const { PROVIDERS, loadProvider } = require('../lib/providers');
    for (const name of ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'custom']) {
        const form = systemAiForm({ provider: name, baseUrl: 'http://ollama:11434/v1', model: 'm' });
        assert.ok(form && form.provider in PROVIDERS, `${name} -> ${form?.provider}`);
        if (form.provider !== 'custom') {
            await loadProvider(form.provider); // throws for a name pi-ai does not know
        }
    }
});

test('systemAiForm: provider names of admin, the base URL only for the custom server', () => {
    assert.equal(systemAiForm(undefined), null);
    assert.equal(systemAiForm({ provider: 'mistral' }), null);
    assert.deepEqual(systemAiForm({ provider: 'gemini', model: ' gemini-3.5-flash ', credentialId: 'c', baseUrl: 'x' }), {
        provider: 'google',
        modelId: 'gemini-3.5-flash',
        baseUrl: '',
        keySource: 'central',
        apiKey: '',
        credentialId: 'c',
    });
    assert.equal(systemAiForm({ provider: 'custom', baseUrl: 'http://ollama:11434/v1' }).baseUrl, 'http://ollama:11434/v1');
    assert.equal(
        systemAiFingerprint(systemAi({ provider: 'openai', hideFab: true })),
        systemAiFingerprint(systemAi({ provider: 'openai', hideFab: false })),
        'a setting of the admin chat does not count',
    );
});

test('system key source: provider, model and key come from system.ai; a change of them restarts', async () => {
    const f = await faux();
    const native = { provider: 'anthropic', model: 'claude-haiku-5-5', credentialId: CREDENTIAL, hideFab: false };
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { provider: 'openai', apiKey: 'sk-own', keySource: 'system' },
        seed: { objects: { [CREDENTIAL]: credentialObject('sk-system'), 'system.ai': systemAi(native) } },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0][0], 'anthropic');
    assert.equal(providerCalls[0][1], 'sk-system');
    assert.equal(providerCalls[0][2].modelId, 'claude-haiku-5-5');
    assert.deepEqual(agent.objectSubscriptions.filter(id => !id.startsWith('system.adapter.')), ['system.ai', CREDENTIAL]);
    assert.equal(agent.db.states[`${NAMESPACE}.info.connection`].val, true);

    agent.emit('objectChange', 'system.ai', systemAi({ ...native, hideFab: true }));
    assert.equal(agent.restarted, undefined, 'the launcher button of admin does not matter');
    agent.emit('objectChange', 'system.ai', systemAi({ ...native, model: 'claude-opus-5-5' }));
    assert.equal(agent.restarted, 1);
    await stopAgent(agent);
});

test('system key source without a provider in system.ai: idle with a hint where to set it up', async () => {
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { keySource: 'system' },
        responses: [],
    });
    assert.equal(providerCalls.length, 0);
    assert.ok(
        agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('tab "AI"')),
        JSON.stringify(agent.logs),
    );
    assert.equal(agent.db.states[`${NAMESPACE}.info.connection`].val, false);
    assert.deepEqual(agent.objectSubscriptions.filter(id => !id.startsWith('system.adapter.')), ['system.ai'], 'setting it up later restarts the instance');
    await stopAgent(agent);
});

test('an instance without a key of its own takes system.ai', async () => {
    const f = await faux();
    const { agent, providerCalls } = await startAgent({
        dataDir: tmp(),
        config: { provider: 'openai', apiKey: '', keySource: 'adapter' },
        seed: {
            objects: {
                [CREDENTIAL]: credentialObject('sk-system'),
                'system.ai': systemAi({ provider: 'deepseek', credentialId: CREDENTIAL }),
            },
        },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.equal(providerCalls[0][0], 'deepseek');
    assert.equal(providerCalls[0][1], 'sk-system');
    await stopAgent(agent);
});

test('Test connection with the system key source checks system.ai, not the form', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), config: { apiKey: '' }, responses: [] });
    const answer = await new Promise(resolve => {
        agent.sendTo = (to, cmd, result) => resolve(result);
        void agent.onMessage({
            command: 'testConnection',
            message: { keySource: 'system', provider: 'openai', apiKey: 'sk-form' },
            from: 'system.adapter.admin.0',
            callback: { id: 1 },
        });
    });
    assert.match(answer.error, /system-wide AI settings have no provider/);
    await stopAgent(agent);
});

test('sendTo "ask" with a conversation: own history and instructions per caller conversation', async () => {
    const f = await faux();
    const seen = [];
    const reply = text => context => {
        // pi-ai keeps the system prompt as the first message, the instructions as one of its sections
        const [system, ...rest] = context.messages;
        seen.push({ system: JSON.stringify(system), messages: JSON.stringify(rest) });
        return f.fauxAssistantMessage(text);
    };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        responses: [reply('one'), reply('two'), reply('three')],
    });
    const ask = message =>
        new Promise(resolve => {
            agent.sendTo = (to, cmd, result) => resolve(result);
            void agent.onMessage({ command: 'ask', message, from: 'system.adapter.assistant.0', callback: 'cb' });
        });

    const spoken = 'Answer in one short spoken sentence.';
    assert.deepEqual(await ask({ text: 'Kitchen question', conversation: 'kitchen', instructions: spoken }), {
        answer: 'one',
    });
    assert.deepEqual(await ask({ text: 'Office question', conversation: 'office' }), { answer: 'two' });
    assert.deepEqual(await ask({ text: 'Kitchen again', conversation: 'kitchen', instructions: spoken }), {
        answer: 'three',
    });

    assert.ok(seen[0].system.includes(spoken), 'the instructions of the caller reach the model');
    assert.ok(!seen[1].system.includes(spoken), 'another conversation has its own instructions');
    assert.ok(!seen[1].messages.includes('Kitchen question'), 'another conversation has its own history');
    assert.ok(seen[2].messages.includes('Kitchen question'), 'the same conversation keeps its history');
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), ['sendTo:assistant.0/kitchen', 'sendTo:assistant.0/office']);
    await stopAgent(agent);
});
