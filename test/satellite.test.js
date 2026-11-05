'use strict';

// 0.9.5: an "ask" of ioBroker.assistant (1.4.9+) names its voice satellite (satellite, tts). A reminder asked there
// becomes a timer on that satellite; when the assistant cannot set one, the reminder is spoken there when due.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-satellite-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const TTS = 'assistant.0.satellites.Gast.tts';
const KEY = 'sendTo:assistant.0/waveshare-va';

/** A tool call turn and a closing answer, as faux responses. */
const turn = (f, name, args) => [
    f.fauxAssistantMessage(f.fauxToolCall(name, args), { stopReason: 'toolUse' }),
    f.fauxAssistantMessage('ok'),
];

/**
 * "ask" from the satellite Gast, like ioBroker.assistant 1.4.9 sends it.
 *
 * @param {object} agent the started adapter
 * @param {object} [extra] fields to change
 */
async function askFromSatellite(agent, extra = {}) {
    await agent.onMessage({
        command: 'ask',
        message: {
            text: 'Erinnere mich in einer Minute an das Licht',
            conversation: 'waveshare-va',
            language: 'de',
            satellite: 'Gast',
            tts: TTS,
            ...extra,
        },
        from: 'system.adapter.assistant.0',
        callback: 'cb',
    });
    return agent.sent.at(-1)[2];
}

const SEED = () => ({
    objects: { [TTS]: { type: 'state', common: { name: 'Speak', type: 'string', role: 'text', write: true } } },
    states: {},
});

test('a reminder asked on a satellite becomes a timer there', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'remind_me', { text: 'Licht schalten', minutes: 1 }),
        hooks: {
            sendToAsync: async (instance, command) =>
                command === 'setTimer' ? { ok: true, id: 't1', fireAt: Date.now() + 60_000 } : undefined,
        },
    });
    assert.deepEqual(await askFromSatellite(agent), { answer: 'ok' });
    const [instance, command, message] = agent.asked.find(a => a[1] === 'setTimer');
    assert.equal(instance, 'assistant.0');
    assert.equal(command, 'setTimer');
    assert.equal(message.satellite, 'Gast');
    assert.equal(message.name, 'Licht schalten');
    assert.equal(message.announce, 'Erinnerung: Licht schalten');
    assert.ok(message.seconds >= 55 && message.seconds <= 60, String(message.seconds));
    // no reminder of its own: the assistant keeps the timer
    assert.deepEqual(await agent.plannedTasks(agent.chats[KEY]), []);
    await stopAgent(agent);
});

test('without a timer of the assistant the reminder is spoken on the satellite when due', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false },
        seed: SEED(),
        responses: turn(f, 'remind_me', { text: 'Licht schalten', minutes: 0.1 }),
        // an assistant before 1.4.9 does not know "setTimer"
        hooks: { sendToAsync: async () => undefined },
    });
    await askFromSatellite(agent);
    await waitFor(async () => db.writes.some(([id]) => id === TTS), 'the spoken reminder');
    assert.deepEqual(
        db.writes.find(([id]) => id === TTS),
        [TTS, 'Erinnerung: Licht schalten'],
    );
    assert.equal(db.states[`${NAMESPACE}.chat.answer`]?.val ?? '', '', 'not in chat.answer');
    await stopAgent(agent);
});

test('a tts state of another adapter is not taken: the reminder goes to chat.answer', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        responses: turn(f, 'remind_me', { text: 'Licht schalten', minutes: 0.1 }),
        hooks: { sendToAsync: async () => ({ ok: true }) },
    });
    await askFromSatellite(agent, { tts: 'hm-rpc.0.heater.STATE' });
    assert.equal(agent.callerVoices.size, 0);
    assert.ok(!agent.asked?.some(a => a[1] === 'setTimer'), 'no timer without a satellite of the caller');
    await waitFor(async () => Boolean(db.states[`${NAMESPACE}.chat.answer`]?.val), 'the reminder');
    assert.match(String(db.states[`${NAMESPACE}.chat.answer`].val), /Licht schalten/);
    assert.ok(!db.writes.some(([id]) => id === 'hm-rpc.0.heater.STATE'));
    await stopAgent(agent);
});
