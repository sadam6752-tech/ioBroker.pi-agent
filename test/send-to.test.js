'use strict';

// 0.6.1: the tool send_to (commands to other adapters, guarded by the write permissions) and the language rule of the
// prompt, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-sendto-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message = {}) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({ command, message, user: 'system.user.admin', from: 'system.adapter.admin.0', callback: { id: 1 } });
    });
}

/** Ask in the admin chat, wait for the answer and return the result of the last send_to call. */
async function askAndResult(agent, text) {
    await call(agent, 'chatSend', { text });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    const history = await call(agent, 'chatHistory');
    return String(history.entries.findLast(e => e.detail?.name === 'send_to')?.detail?.result ?? '');
}

const SEND = { instance: 'telegram.0', command: 'send', message: { text: 'Hello' } };

test('send_to: to an instance with "Write allowed" the command goes out and the answer comes back', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'telegram.0', write: true, confirm: false }] },
        hooks: { sendToAsync: async (instance, command) => (command === 'send' ? 1 : undefined) },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('send_to', SEND), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Sent.'),
        ],
    });
    assert.match(await askAndResult(agent, 'send hello'), /^Sent\. Answer of telegram\.0: 1$/);
    assert.deepEqual(agent.asked.at(-1), ['telegram.0', 'send', { text: 'Hello' }]);
    await stopAgent(agent);
});

test('send_to: not allowed, a pattern row, pi-agent itself and simulation mode send nothing', async () => {
    const f = await faux();
    const tryIt = async (config, args) => {
        const { agent } = await startAgent({
            dataDir: tmp(),
            config,
            responses: [f.fauxAssistantMessage(f.fauxToolCall('send_to', args), { stopReason: 'toolUse' }), f.fauxAssistantMessage('ok')],
        });
        const result = await askAndResult(agent, 'send');
        const sent = (agent.asked || []).filter(([instance]) => instance === args.instance);
        await stopAgent(agent);
        return { result, sent };
    };
    let outcome = await tryIt({ dryRun: false, writeRules: [] }, SEND);
    assert.match(outcome.result, /not allowed/);
    assert.deepEqual(outcome.sent, []);

    // a row for some states of the instance does not allow commands to the whole instance
    outcome = await tryIt({ dryRun: false, writeRules: [{ scope: 'telegram.0.communicate.*', write: true }] }, SEND);
    assert.match(outcome.result, /not allowed/);

    outcome = await tryIt({ dryRun: false, writeAllow: '.*' }, { ...SEND, instance: 'pi-agent.0' });
    assert.match(outcome.result, /not allowed/);
    assert.deepEqual(outcome.sent, []);

    outcome = await tryIt({ dryRun: true, writeRules: [{ scope: 'telegram.0', write: true }] }, SEND);
    assert.match(outcome.result, /DRY RUN - NOTHING WAS SENT/);
    assert.deepEqual(outcome.sent, []);
});

test('send_to: with "Confirmation required" the command is asked in the chat first', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'telegram.0', write: true, confirm: true }] },
        hooks: { sendToAsync: async () => 1 },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('send_to', SEND), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Sent.'),
        ],
    });
    await call(agent, 'chatSend', { text: 'send hello' });
    let question;
    await waitFor(async () => (question = (await call(agent, 'chatHistory')).question), 'the question');
    assert.deepEqual([question.action, question.id, question.val], ['sendTo', 'telegram.0', 'send']);
    assert.equal((agent.asked || []).filter(([instance]) => instance === 'telegram.0').length, 0, 'not sent before');
    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    assert.deepEqual(agent.asked.at(-1), ['telegram.0', 'send', { text: 'Hello' }]);
    await stopAgent(agent);
});

test('prompt: answer in the language of the question unless the instructions name one', async () => {
    const f = await faux();
    let prompt = '';
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { instructions: 'Antworte immer auf Deutsch.' },
        responses: [
            ctx => {
                prompt = JSON.stringify(ctx);
                return f.fauxAssistantMessage('Hallo');
            },
        ],
    });
    await call(agent, 'chatSend', { text: 'привет' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    const rule = prompt.indexOf("Answer in the language of the user's last message, unless the instructions below");
    const own = prompt.indexOf('Antworte immer auf Deutsch.');
    assert.ok(rule > 0, 'the language rule is in the prompt');
    assert.ok(own > rule, 'the instructions of the user come after the rule that defers to them');
    await stopAgent(agent);
});
