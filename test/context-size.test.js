'use strict';

// Limit of the context of a request (lib/context-size.js): the compaction policy for pi-durable and the debug line.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_CONTEXT_TOKENS, contextLimitOf, compactionPolicyFor, usageLine } = require('../lib/context-size');

test('the setting: 0 or nothing means no limit, small values are raised to the minimum', () => {
    assert.equal(contextLimitOf(0), 0);
    assert.equal(contextLimitOf(''), 0);
    assert.equal(contextLimitOf(undefined), 0);
    assert.equal(contextLimitOf(-5), 0);
    assert.equal(contextLimitOf(1000), MIN_CONTEXT_TOKENS);
    assert.equal(contextLimitOf('40000'), 40000);
    assert.equal(contextLimitOf(40000.7), 40000);
});

test('the policy compacts at the limit, in the background from three quarters on', () => {
    const policy = compactionPolicyFor(40000, 128000);
    assert.deepEqual(policy, { reserveTokens: 88000, keepRecentTokens: 12000, backgroundTokens: 10000 });
    // the harness compacts blocking above contextWindow - reserveTokens, in the background backgroundTokens earlier
    assert.equal(128000 - policy.reserveTokens, 40000);
    assert.equal(128000 - policy.reserveTokens - policy.backgroundTokens, 30000);
});

test('no policy without a limit, without a window, or when the window allows no smaller context', () => {
    assert.equal(compactionPolicyFor(0, 128000), null);
    assert.equal(compactionPolicyFor(40000, 0), null);
    assert.equal(compactionPolicyFor(40000, 50000), null);
    assert.equal(compactionPolicyFor(200000, 128000), null);
});

test('the debug line shows the context, the share from the cache, the answer and the cost', () => {
    const line = usageLine('deepseek/deepseek-flash', {
        input: 2000,
        output: 120,
        cacheRead: 48000,
        cacheWrite: 0,
        cost: { total: 0.00089 },
    });
    assert.equal(
        line,
        'Model call deepseek/deepseek-flash: context 50000 tokens (48000 from the cache = 96 %, 2000 new), answer 120, cost $0.00089',
    );
    assert.match(
        usageLine('x/y', undefined),
        /context 0 tokens \(0 from the cache = 0 %, 0 new\), answer 0, cost \$0\.00000/,
    );
    assert.match(usageLine('x/y', { input: 10, cacheWrite: 90 }), /90 written to the cache/);
});

test('through main.js: the limit reaches the harness, and every model call is in the debug log', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { startAgent, stopAgent } = require('./helpers/agent-harness');
    const f = await import('@earendil-works/pi-ai/providers/faux');
    const { agent } = await startAgent({
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-context-')),
        config: { contextTokens: 30000 },
        responses: [f.fauxAssistantMessage('done')],
    });
    const answer = await new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, reply) => {
            agent.sendTo = sendTo;
            resolve(reply);
        };
        agent.onMessage({
            command: 'ask',
            message: { text: 'hello', conversation: 'chat' },
            from: 'system.adapter.assistant.0',
            callback: { id: 1 },
        });
    });
    assert.deepEqual(answer, { answer: 'done' });
    const lines = agent.logs.map(([level, msg]) => `${level} ${msg}`);
    assert.ok(
        lines.some(line => /^info .*(stays below 30000 tokens|Context limit 30000 tokens)/.test(line)),
        lines.join('\n'),
    );
    assert.ok(
        lines.some(line => /^debug Model call .*: context \d+ tokens .*answer \d+, cost \$/.test(line)),
        lines.join('\n'),
    );
    await stopAgent(agent);
});
