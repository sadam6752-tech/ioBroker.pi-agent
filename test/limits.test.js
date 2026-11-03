'use strict';

// Requests per minute and conversation, tokens per day (lib/limits.js), with a clock of the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimits, WINDOW_MS } = require('../lib/limits');

const ZONE = 'Europe/Berlin';
// 2026-11-03 12:00 in Berlin (CET, UTC+1)
const NOON = Date.UTC(2026, 10, 3, 11, 0, 0);

/**
 * Limits with a clock that the test moves.
 *
 * @param {{ perMinute?: number, dailyTokens?: number }} settings limits
 * @returns {{ limits: any, clock: { t: number }, warnings: string[] }} limits, clock and logged warnings
 */
function setup({ perMinute = 0, dailyTokens = 0 } = {}) {
    const clock = { t: NOON };
    const warnings = [];
    const limits = createLimits({
        perMinute,
        dailyTokens,
        timeZone: ZONE,
        log: { warn: msg => warnings.push(msg) },
        now: () => clock.t,
    });
    return { limits, clock, warnings };
}

test('requests per minute: the request over the limit is refused, warned once, and the next minute is free again', () => {
    const { limits, clock, warnings } = setup({ perMinute: 3 });
    for (let i = 0; i < 3; i++) {
        limits.admit('sendTo:assistant.0/chat');
        clock.t += 1000;
    }
    assert.throws(() => limits.admit('sendTo:assistant.0/chat'), /Too many requests .*\(at most 3 per minute\)/);
    assert.throws(() => limits.admit('sendTo:assistant.0/chat'), /Too many requests/);
    assert.equal(warnings.length, 1, 'one warning for the whole run');
    assert.match(warnings[0], /sendTo:assistant\.0\/chat: more than 3 requests per minute/);

    limits.admit('telegram.0/42'); // another conversation has its own count

    clock.t += WINDOW_MS;
    limits.admit('sendTo:assistant.0/chat');
    for (let i = 0; i < 2; i++) {
        limits.admit('sendTo:assistant.0/chat');
    }
    assert.throws(() => limits.admit('sendTo:assistant.0/chat'), /Too many requests/);
    assert.equal(warnings.length, 2, 'a new run is warned again');
});

test('requests per minute 0: no limit', () => {
    const { limits } = setup({ perMinute: 0 });
    for (let i = 0; i < 100; i++) {
        limits.admit('admin/admin');
    }
});

test('tokens per day: the growth of the total counts, a shrinking total (old conversations deleted) counts nothing', () => {
    const { limits, clock, warnings } = setup({ dailyTokens: 1000 });
    limits.restore(0, NOON - 3600_000, 50_000);
    assert.deepEqual(limits.count(50_400), { tokens: 400, reached: false });
    assert.deepEqual(limits.count(30_000), { tokens: 400, reached: false }, 'conversations deleted');
    assert.deepEqual(limits.count(30_700), { tokens: 1100, reached: true });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /daily token limit \(1000\) is reached with 1100 tokens/);
    assert.throws(() => limits.admit('admin/admin'), /daily token limit \(1000\) is reached; .* after midnight/);
    limits.count(30_800);
    assert.equal(warnings.length, 1, 'warned once a day');

    // 00:00 in Berlin is 23:00 UTC
    clock.t = Date.UTC(2026, 10, 3, 23, 0, 1);
    assert.equal(limits.reached(), false, 'a new day');
    limits.admit('admin/admin');
    assert.deepEqual(limits.count(30_900), { tokens: 100, reached: false });
});

test('tokens per day: the count of the last run continues on the same day and starts at 0 on the next', () => {
    const { limits } = setup({ dailyTokens: 1000 });
    limits.restore(900, NOON - 3600_000, 10_000);
    assert.deepEqual(limits.count(10_200), { tokens: 1100, reached: true });

    const next = setup({ dailyTokens: 1000 });
    next.limits.restore(900, NOON - 24 * 3600_000, 10_000);
    assert.deepEqual(next.limits.count(10_200), { tokens: 200, reached: false });
});

test('tokens per day 0: counted, never reached', () => {
    const { limits } = setup({ dailyTokens: 0 });
    limits.restore(0, NOON, 0);
    assert.deepEqual(limits.count(5_000_000), { tokens: 5_000_000, reached: false });
    limits.admit('admin/admin');
});

test('through main.js: the request over the limit of its conversation is refused without asking the model', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { startAgent, stopAgent } = require('./helpers/agent-harness');
    const f = await import('@earendil-works/pi-ai/providers/faux');
    const { agent } = await startAgent({
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-limits-')),
        config: { requestsPerMinute: 2 },
        responses: [f.fauxAssistantMessage('one'), f.fauxAssistantMessage('two'), f.fauxAssistantMessage('other')],
    });
    const ask = (text, conversation) =>
        new Promise(resolve => {
            const sendTo = agent.sendTo.bind(agent);
            agent.sendTo = (to, cmd, answer) => {
                agent.sendTo = sendTo;
                resolve(answer);
            };
            agent.onMessage({
                command: 'ask',
                message: { text, conversation },
                from: 'system.adapter.assistant.0',
                callback: { id: 1 },
            });
        });
    assert.deepEqual(await ask('first', 'chat'), { answer: 'one' });
    assert.deepEqual(await ask('second', 'chat'), { answer: 'two' });
    const refused = await ask('third', 'chat');
    assert.match(String(refused.error), /Too many requests from this conversation \(at most 2 per minute\)/);
    assert.deepEqual(await ask('hello', 'kitchen'), { answer: 'other' }, 'another conversation is not limited');
    assert.ok(Number((await agent.getStateAsync('usage.tokensToday'))?.val) > 0, 'tokens of the day counted');
    assert.equal((await agent.getStateAsync('usage.limitReached'))?.val, false);
    await stopAgent(agent);
});
