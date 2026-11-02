'use strict';

// Code mode (setting "codeMode"): the model writes a script that calls the ioBroker tools in a QuickJS sandbox. Every
// call of the script is a tool call of its own, so the write permissions, the simulation mode and the confirmations
// hold for it; a script survives a restart without running its finished calls again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_CONFIG } = require('./helpers/crash-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-codemode-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const HEATER = 'hm-rpc.0.heater.STATE';
const LAMP = 'hm-rpc.0.lamp.STATE';
const SEED = () => ({
    objects: {
        [HEATER]: {
            type: 'state',
            common: { name: 'Heater', type: 'boolean', role: 'switch', read: true, write: true },
        },
        [LAMP]: { type: 'state', common: { name: 'Lamp', type: 'boolean', role: 'switch', read: true, write: true } },
    },
    states: { [HEATER]: { val: true, ack: true, ts: 1 }, [LAMP]: { val: false, ack: true, ts: 1 } },
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
            agent.onMessage({
                command,
                message,
                user: 'system.user.admin',
                from: 'system.adapter.admin.0',
                callback: { id: 1 },
            });
        });
}

/** The result of the last tool call of the admin chat, once its request is answered. */
async function lastResult(agent) {
    const call = page(agent);
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    const conversation = await agent.harness.conversation(agent.chats['admin/system.user.admin'], agent.context);
    const view = await conversation.viewState(agent.context);
    const results = view.value.entries
        .filter(e => e.kind === 'pi.tool-result')
        .flatMap(e => e.model)
        .map(m => m.content.map(p => p.text).join(''));
    view.dispose?.();
    return results.at(-1) ?? '';
}

/** A code mode call with a script and a closing answer, as faux responses. */
const script = (f, code, closing = 'ok') => [
    f.fauxAssistantMessage(f.fauxToolCall('codemode', { code }), { stopReason: 'toolUse' }),
    f.fauxAssistantMessage(closing),
];

/** Tool calls the adapter logged, by name. */
const calls = (agent, name) => agent.logs.filter(([, m]) => m.startsWith(`Tool ${name} `)).length;

test('code mode is off by default: no codemode tool', async () => {
    const f = await faux();
    const { agent } = await startAgent({ dataDir: tmp(), seed: SEED(), responses: [f.fauxAssistantMessage('hi')] });
    const conversation = await agent.harness.conversation(agent.root.id, agent.context);
    assert.ok(conversation);
    assert.ok(!agent.codemodeSandbox);
    assert.ok(!agent.logs.some(([, m]) => m.startsWith('Code mode is on')));
    await stopAgent(agent);
});

test('a script gets the values of the read tools as objects', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { codeMode: true },
        seed: SEED(),
        responses: script(
            f,
            `const s = await tools.get_state({ id: '${HEATER}' });
             const all = await tools.get_state({ id: 'hm-rpc.0.*' });
             const none = await tools.get_state({ id: 'nope.0.x' });
             text('heater ' + s.val + ', ' + all.total + ' states, missing ' + none);`,
        ),
    });
    await page(agent)('chatSend', { text: 'read' });
    assert.match(await lastResult(agent), /heater true, 2 states, missing null/);
    await stopAgent(agent);
});

test('in a script, a write that is not allowed is blocked and simulation mode writes nothing', async () => {
    const f = await faux();
    const blocked = await startAgent({
        dataDir: tmp(),
        config: { codeMode: true, dryRun: false, writeRules: [] },
        seed: SEED(),
        responses: script(
            f,
            `try { await tools.set_state({ id: '${HEATER}', val: false }); text('WRITTEN'); } catch (e) { text('BLOCKED ' + e.message); }`,
        ),
    });
    await page(blocked.agent)('chatSend', { text: 'write' });
    assert.match(await lastResult(blocked.agent), /BLOCKED .*not on the write allowlist/);
    assert.deepEqual(blocked.db.writes, []);
    await stopAgent(blocked.agent);

    const simulated = await startAgent({
        dataDir: tmp(),
        config: { codeMode: true, dryRun: true, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: script(f, `text(await tools.set_state({ id: '${HEATER}', val: false }));`),
    });
    await page(simulated.agent)('chatSend', { text: 'write' });
    assert.match(await lastResult(simulated.agent), /DRY RUN - NOTHING WAS WRITTEN/);
    assert.deepEqual(simulated.db.writes, []);
    await stopAgent(simulated.agent);
});

test('in a script, every write on the confirmation list is asked on its own', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { codeMode: true, dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true, confirm: true }] },
        seed: SEED(),
        responses: script(
            f,
            `for (const id of ['${HEATER}', '${LAMP}']) {
                try { await tools.set_state({ id, val: true }); text('OK ' + id); } catch (e) { text('NO ' + id); }
             }`,
        ),
    });
    const call = page(agent);
    await call('chatSend', { text: 'both on' });
    let q;
    await waitFor(async () => (q = (await call('chatHistory')).question), 'the first question');
    assert.equal(q.id, HEATER);
    await call('chatConfirm', { nonce: q.nonce, answer: 'no' });
    await waitFor(async () => (q = (await call('chatHistory')).question)?.id === LAMP, 'the second question');
    await call('chatConfirm', { nonce: q.nonce, answer: 'yes' });
    const result = await lastResult(agent);
    assert.match(result, /NO hm-rpc\.0\.heater\.STATE/);
    assert.match(result, /OK hm-rpc\.0\.lamp\.STATE/);
    assert.deepEqual(db.writes, [[LAMP, true]]);
    await stopAgent(agent);
});

test('a script in a background job asks before a write, also without "Confirmation required"', async () => {
    const f = await faux();
    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        config: { codeMode: true, dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: [
            f.fauxAssistantMessage(
                f.fauxToolCall('create_job', {
                    name: 'Lamp',
                    task: 'When the heater changes, switch the lamp on.',
                    triggers: [{ kind: 'state', id: HEATER, condition: 'changes' }],
                }),
                { stopReason: 'toolUse' },
            ),
            f.fauxAssistantMessage('ok'),
        ],
    });
    await page(agent)('chatSend', { text: 'lamp on when the heater changes' });
    await lastResult(agent);
    provider.setResponses(
        script(
            f,
            `try { await tools.set_state({ id: '${LAMP}', val: true }); text('ON'); } catch (e) { text('NOT ' + e.message); }`,
            'Lamp not switched.',
        ),
    );
    await agent.onStateChange(HEATER, { val: false, ack: true, ts: 2 });
    const call = page(agent);
    let q;
    await waitFor(async () => (q = (await call('chatHistory')).question), 'the question of the job');
    assert.equal(q.id, LAMP);
    await call('chatConfirm', { nonce: q.nonce, answer: 'no' });
    await waitFor(
        async () => agent.adminChat.notices('system.user.admin').some(n => n.html.includes('Lamp not switched.')),
        'the answer of the job',
    );
    assert.deepEqual(db.writes, []);
    await stopAgent(agent);
});

test('a crash in the middle of a script: the read is not repeated, the write not run twice', async () => {
    const f = await faux();
    const dataDir = tmp();
    const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'crash-codemode-child.js'), dataDir], {
        encoding: 'utf8',
        timeout: 60000,
    });
    assert.equal(child.status, 137, `child ended with ${child.status}: ${child.stderr}`);

    let seenByModel = '';
    const second = await startAgent({
        dataDir,
        config: { ...CRASH_CONFIG, codeMode: true },
        responses: [
            context => {
                seenByModel = JSON.stringify(context.messages);
                return f.fauxAssistantMessage('I checked the lamp.');
            },
        ],
    });
    await waitFor(() => second.db.states[`${NAMESPACE}.chat.pending`]?.val === '', 'the resumed request to finish');
    assert.deepEqual(second.db.writes, [['x.0.lamp', true]], 'exactly one write, the one before the crash');
    assert.equal(calls(second.agent, 'get_state'), 0, 'the read before the crash comes from the journal');
    assert.match(seenByModel, /interrupted/i, 'the model learns that the write was interrupted');
    await stopAgent(second.agent);
});

test('with code mode the instructions tell how to write a script; without it they do not', async () => {
    const f = await faux();
    for (const codeMode of [true, false]) {
        let prompt = '';
        const { agent } = await startAgent({
            dataDir: tmp(),
            config: { codeMode },
            seed: SEED(),
            responses: [
                context => {
                    prompt = JSON.stringify(context.messages.filter(m => m.role === 'system'));
                    return f.fauxAssistantMessage('hi');
                },
            ],
        });
        await page(agent)('chatSend', { text: 'hello' });
        await lastResult(agent);
        assert.ok(prompt.includes('You control an ioBroker smart home'), 'the instructions were seen');
        assert.equal(prompt.includes('Never print whole tool results'), codeMode);
        await stopAgent(agent);
    }
});
