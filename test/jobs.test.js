'use strict';

// Background jobs (create_job, list_jobs, stop_job, resume_job) through the real main.js and the tools as the model
// calls them: the adapter watches the triggers, a trigger wakes the job's own conversation, its answer goes to the
// targets of the job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { normalizeTrigger, triggerText, MAX_WAKES_PER_DAY } = require('../lib/jobs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-jobs-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const WINDOW = 'hm-rpc.0.window.STATE';
const HEATER = 'hm-rpc.0.heater.STATE';
const TTS = 'assistant.0.tts.text';
const SEED = () => ({
    objects: {
        [WINDOW]: {
            type: 'state',
            common: { name: 'Window', type: 'boolean', role: 'sensor.window', read: true, write: false },
        },
        [HEATER]: {
            type: 'state',
            common: { name: 'Heater', type: 'boolean', role: 'switch', read: true, write: true },
        },
        'system.adapter.assistant.0': { type: 'instance', common: { name: 'assistant' } },
        [TTS]: { type: 'state', common: { name: 'TTS', type: 'string', role: 'text', read: true, write: true } },
    },
    states: { [WINDOW]: { val: false, ack: true, ts: 1 }, [HEATER]: { val: true, ack: true, ts: 1 } },
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

/** Ask in the admin chat and return the raw result of the last tool call. */
async function ask(agent, text) {
    const call = page(agent);
    await call('chatSend', { text });
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

/** The messages the admin chat shows outside of its requests (reminders, jobs). */
const notices = agent => agent.adminChat.notices('system.user.admin').map(n => n.html);

/** A tool call turn and a closing answer, as faux responses. */
const turn = (f, name, args, closing = 'ok') => [
    f.fauxAssistantMessage(f.fauxToolCall(name, args), { stopReason: 'toolUse' }),
    f.fauxAssistantMessage(closing),
];

const WINDOW_JOB = {
    name: 'Vacation',
    task: 'Tell me when the window is open while I am away.',
    triggers: [{ kind: 'state', id: WINDOW, condition: '==', value: true }],
};

test('normalizeTrigger: state, daily and interval; wrong ones are refused', () => {
    assert.deepEqual(normalizeTrigger({ kind: 'state', id: WINDOW, condition: '==', value: true, minutes: 15 }), {
        kind: 'state',
        stateId: WINDOW,
        condition: '==',
        value: true,
        forMs: 900_000,
    });
    assert.deepEqual(normalizeTrigger({ kind: 'daily', time: '7:05' }), { kind: 'daily', time: '07:05' });
    assert.deepEqual(normalizeTrigger({ kind: 'interval', minutes: 60 }), { kind: 'interval', minutes: 60 });
    assert.throws(() => normalizeTrigger({ kind: 'interval', minutes: 5 }), /from 15/);
    assert.throws(() => normalizeTrigger({ kind: 'daily', time: '25:00' }), /HH:MM/);
    assert.throws(() => normalizeTrigger({ kind: 'state', id: WINDOW, condition: '==' }), /needs a value/);
    assert.throws(() => normalizeTrigger({ kind: 'cron' }), /must be "state", "daily" or "interval"/);
    assert.equal(
        triggerText(normalizeTrigger({ kind: 'state', id: WINDOW, condition: '==', value: true, minutes: 15 })),
        `${WINDOW} == true for 15 minute(s)`,
    );
});

test('create_job: a state trigger wakes the job, its answer reaches the chat; [[SILENT]] tells nothing; again only after the condition broke off', async () => {
    const f = await faux();
    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'create_job', WINDOW_JOB),
    });
    const created = JSON.parse(await ask(agent, 'watch the window while I am away'));
    assert.equal(created.created.name, 'Vacation');
    assert.deepEqual(created.created.notify, ['admin/system.user.admin']);
    assert.ok(agent.foreignSubscriptions.includes(WINDOW));
    assert.equal(JSON.parse(db.states[`${NAMESPACE}.scheduled.jobs`].val).length, 1);

    provider.setResponses([f.fauxAssistantMessage('The window is open!'), f.fauxAssistantMessage('[[SILENT]]')]);
    await agent.onStateChange(WINDOW, { val: true, ack: false, ts: 2 }); // a command, not the device
    assert.deepEqual(notices(agent), []);
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 3 });
    await waitFor(async () => notices(agent).length === 1, 'the message of the job');
    assert.match(notices(agent)[0], /Vacation: The window is open!/);

    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 4 }); // still open: no new wake-up
    await agent.onStateChange(WINDOW, { val: false, ack: true, ts: 5 });
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 6 });
    await waitFor(
        async () => agent.logs.some(([, m]) => /Job j[0-9a-f]+ "Vacation": nothing to tell/.test(m)),
        'the silent answer',
    );
    assert.equal(notices(agent).length, 1);
    assert.equal(agent.jobs.list()[0].total, 2);
    await stopAgent(agent);
});

test('a job asks before every write, also without "Confirmation required"', async () => {
    const f = await faux();
    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'hm-rpc.0', write: true }] },
        seed: SEED(),
        responses: turn(f, 'create_job', { ...WINDOW_JOB, task: 'When the window opens, switch the heater off.' }),
    });
    await ask(agent, 'heater off when the window opens');
    provider.setResponses(turn(f, 'set_state', { id: HEATER, val: false }, 'Not switched.'));
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    const call = page(agent);
    let question;
    await waitFor(async () => (question = (await call('chatHistory')).question), 'the question');
    assert.deepEqual([question.id, question.val], [HEATER, false]);
    await call('chatConfirm', { nonce: question.nonce, answer: 'no' });
    await waitFor(async () => notices(agent).some(n => n.includes('Not switched.')), 'the answer of the job');
    assert.deepEqual(db.writes.filter(([id]) => id === HEATER), []);
    await stopAgent(agent);
});

test('a job survives a restart; stop_job ends it and its subscription', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({ dataDir, seed: SEED(), responses: turn(f, 'create_job', WINDOW_JOB) });
    await ask(first.agent, 'watch the window');
    const id = first.agent.jobs.list()[0].id;
    await stopAgent(first.agent);

    const second = await startAgent({
        dataDir,
        responses: [f.fauxAssistantMessage('Window open after the restart')],
    });
    assert.ok(second.agent.foreignSubscriptions.includes(WINDOW), 'subscribed again at the start');
    await second.agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    await waitFor(async () => notices(second.agent).some(n => n.includes('after the restart')), 'the message');

    second.faux.setResponses(turn(f, 'stop_job', { id }, 'Stopped.'));
    assert.match(await ask(second.agent, 'stop the vacation job'), new RegExp(`^Job ${id} "Vacation" stopped`));
    assert.deepEqual(second.agent.jobs.list(), []);
    assert.ok(!second.agent.foreignSubscriptions.includes(WINDOW), 'unsubscribed');
    await stopAgent(second.agent);
});

test('a job that stops itself still tells its last answer', async () => {
    const f = await faux();
    const { agent, faux: provider } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'create_job', { ...WINDOW_JOB, task: 'Tell me once when the window opens.' }),
    });
    await ask(agent, 'tell me once');
    const id = agent.jobs.list()[0].id;
    provider.setResponses(turn(f, 'stop_job', { id }, 'The window is open.'));
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    await waitFor(async () => notices(agent).some(n => n.includes('The window is open.')), 'the last answer');
    assert.match(notices(agent).at(-1), /The job has ended/);
    assert.deepEqual(agent.jobs.list(), []);
    await stopAgent(agent);
});

test('voice: spoken by the assistant only with the write permission; a job cannot create jobs', async () => {
    const f = await faux();
    const refused = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false },
        seed: SEED(),
        responses: turn(f, 'create_job', { ...WINDOW_JOB, notify: ['voice'] }),
    });
    assert.match(await ask(refused.agent, 'tell me by voice'), /Write allowed" for assistant\.0\.tts\.text/);
    await stopAgent(refused.agent);

    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'assistant.0.tts', write: true }] },
        seed: SEED(),
        responses: turn(f, 'create_job', { ...WINDOW_JOB, notify: ['voice', 'admin'] }),
    });
    await ask(agent, 'tell me by voice and in the admin chat');
    assert.deepEqual(agent.jobs.list()[0].notify, [`voice:${TTS}`, 'admin/system.user.admin']);
    provider.setResponses(turn(f, 'create_job', WINDOW_JOB, 'Window open.'));
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    await waitFor(async () => db.writes.some(([id]) => id === TTS), 'the spoken text');
    assert.deepEqual(
        db.writes.find(([id]) => id === TTS),
        [TTS, 'Vacation: Window open.'],
    );
    assert.equal(agent.jobs.list().length, 1, 'the job did not create another one');
    assert.ok(agent.logs.some(([, m]) => /create_job .* refused: A background job cannot create jobs/.test(m)));
    await stopAgent(agent);
});

test(`a job woken more than ${MAX_WAKES_PER_DAY} times a day is paused; resume_job starts it again`, async () => {
    const f = await faux();
    const { agent, faux: provider } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'create_job', WINDOW_JOB),
    });
    await ask(agent, 'watch the window');
    const job = agent.jobs.list()[0];
    job.wakes = MAX_WAKES_PER_DAY;
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    await waitFor(async () => notices(agent).some(n => n.includes('is paused')), 'the message about the pause');
    assert.equal(job.paused, true);
    assert.ok(!agent.foreignSubscriptions.includes(WINDOW), 'a paused job does not listen');

    provider.setResponses(turn(f, 'resume_job', { id: job.id }));
    assert.match(await ask(agent, 'resume it'), /runs again/);
    assert.equal(job.paused, false);
    assert.ok(agent.foreignSubscriptions.includes(WINDOW));
    await stopAgent(agent);
});

test('create_job: at most 5 jobs, a state that does not exist is refused', async () => {
    const f = await faux();
    const responses = [];
    for (let i = 0; i < 6; i++) {
        responses.push(...turn(f, 'create_job', { ...WINDOW_JOB, name: `Job ${i}` }));
    }
    responses.push(
        ...turn(f, 'create_job', {
            ...WINDOW_JOB,
            triggers: [{ kind: 'state', id: 'nope.0.x', condition: '==', value: 1 }],
        }),
    );
    const { agent } = await startAgent({ dataDir: tmp(), seed: SEED(), responses });
    for (let i = 0; i < 5; i++) {
        await ask(agent, `job ${i}`);
    }
    assert.match(await ask(agent, 'one more'), /already 5 jobs/);
    await agent.jobs.remove(agent.jobs.list()[0].id);
    assert.match(await ask(agent, 'a wrong state'), /State nope\.0\.x does not exist/);
    await stopAgent(agent);
});

test('admin tab: chatHistory lists the jobs; chatJobStop and chatJobResume act on them', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'create_job', {
            ...WINDOW_JOB,
            triggers: [...WINDOW_JOB.triggers, { kind: 'daily', time: '07:00' }],
        }),
    });
    await ask(agent, 'watch the window');
    const call = page(agent);
    const [job] = (await call('chatHistory')).jobs;
    assert.equal(job.name, 'Vacation');
    assert.equal(job.paused, false);
    assert.deepEqual(
        job.triggers.map(t => t.kind),
        ['state', 'daily'],
    );
    assert.deepEqual(job.notify, ['admin/system.user.admin']);

    agent.jobs.list()[0].wakes = MAX_WAKES_PER_DAY;
    await agent.onStateChange(WINDOW, { val: true, ack: true, ts: 2 });
    await waitFor(async () => (await call('chatHistory')).jobs[0].paused, 'the pause');
    assert.equal((await call('chatJobResume', { id: job.id })).jobs[0].paused, false);
    assert.deepEqual((await call('chatJobStop', { id: job.id })).jobs, []);
    assert.deepEqual(agent.jobs.list(), []);
    await stopAgent(agent);
});
