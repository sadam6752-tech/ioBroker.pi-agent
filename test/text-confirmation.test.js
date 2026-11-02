'use strict';

// 0.7.2: confirmation by text in the conversations of sendTo callers (ioBroker.assistant): the question is the answer
// of the waiting "ask", the next "ask" of the conversation decides, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');
const { isYes, confirmationQuestion } = require('../lib/text-confirmation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-textconfirm-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const LAMP = '0_userdata.0.lamp';
const SEED = () => ({
    objects: {
        'system.config': { type: 'config', common: { language: 'ru' }, native: {} },
        [LAMP]: { type: 'state', common: { name: { en: 'Kitchen lamp', ru: 'Лампа на кухне' }, type: 'boolean' } },
    },
    states: { [LAMP]: { val: false, ack: true } },
});
const CONFIG = (textConfirmation = true) => ({
    dryRun: false,
    textConfirmation,
    writeRules: [{ scope: LAMP, write: true, confirm: true }],
});

/**
 * "ask" of ioBroker.assistant in the conversation "kitchen"; returns what its callback got.
 *
 * @param {object} agent the started adapter
 * @param {string} text what the user said
 * @param {object} [extra] more fields of the message, e.g. language
 */
async function ask(agent, text, extra = {}) {
    await agent.onMessage({
        command: 'ask',
        message: { text, conversation: 'kitchen', ...extra },
        from: 'system.adapter.assistant.0',
        callback: 'cb',
    });
    return agent.sent.at(-1)[2];
}

test('isYes: what the user said is a yes word of any language, apart from case and punctuation', () => {
    for (const yes of ['да', 'Да.', ' ДА! ', 'yes', 'Yes!', 'Ja', 'ja', 'Sí.', 'так']) {
        assert.equal(isYes(yes), true, yes);
    }
    for (const no of ['нет', 'nein', 'да, но сначала скажи', 'ja bitte', 'ok', '', 'конечно', 'jaja', 'да нет']) {
        assert.equal(isYes(no), false, no);
    }
});

test('isYes: the same yes twice is yes (speech recognition turned a spoken "Да." into "Да да.")', () => {
    for (const yes of ['Да да.', 'Ja, ja.', 'yes yes', 'да-да']) {
        assert.equal(isYes(yes), true, yes);
    }
    // what a Russian speech recognition made of a German "Ja": not a yes word
    assert.equal(isYes('Я'), false);
});

test('isYes: context in front of the words of the user (ioBroker.assistant) does not count', () => {
    const context = 'Aktuelle Zeit: Donnerstag, 30.10.2026, 14:52\n\nWetter: 12 °C, bewölkt\n\nAnwesend: Alex';
    assert.equal(isYes(`${context}\n\nja`), true);
    assert.equal(isYes(`${context}\n\nJa.`), true);
    assert.equal(isYes(`${context}\n\nnein`), false);
    assert.equal(isYes(`${context}\n\nja, aber erst die Temperatur`), false);
    assert.equal(isYes('ja\n\nnein'), false, 'only the last paragraph is what the user said');
});

test('confirmationQuestion: plain text in the system language, with [[LISTEN]]', () => {
    assert.equal(
        confirmationQuestion('ru', { what: 'telegram.0', action: 'restart' }),
        'Перезапустить инстанс telegram.0? Скажи да или нет. [[LISTEN]]',
    );
    assert.equal(
        confirmationQuestion('de', { what: 'Lampe', val: true }),
        'Lampe auf true setzen? Sag ja oder nein. [[LISTEN]]',
    );
    assert.match(
        confirmationQuestion('xx', { what: 'telegram', val: '1.0.0 → 1.1.0 (repository)', action: 'update' }),
        /^Update the adapter telegram, 1\.0\.0 → 1\.1\.0 \(repository\)\?/,
    );
    assert.match(confirmationQuestion('ru-RU', { what: 'telegram.0', action: 'restart' }), /^Перезапустить/);
    assert.match(confirmationQuestion('zh-cn', { what: 'telegram.0', action: 'restart' }), /^重启/);
});

test('the language of the caller wins over the system language: a satellite that listens in German is asked in German', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(), // system language ru
        config: CONFIG(),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: LAMP, val: true }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Die Lampe ist an.'),
        ],
    });
    const question = await ask(agent, 'Schalte die Küchenlampe ein', { language: 'de' });
    // no German name: the English one, not the Russian one of the system language
    assert.deepEqual(question, { answer: 'Kitchen lamp auf true setzen? Sag ja oder nein. [[LISTEN]]' });
    assert.deepEqual(await ask(agent, 'Ja, ja.', { language: 'de' }), { answer: 'Die Lampe ist an.' });
    assert.deepEqual(db.writes, [[LAMP, true]]);
    assert.ok(agent.logs.some(([, msg]) => /Answer by text in .*: "Ja, ja\." → yes/.test(msg)), 'what was heard is logged');
    await stopAgent(agent);
});

test('"да" as the next ask confirms the write, and its answer is the result', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: CONFIG(),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: LAMP, val: true }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Лампа включена.'),
        ],
    });
    const question = await ask(agent, 'Включи лампу на кухне');
    assert.deepEqual(question, { answer: 'Установить Лампа на кухне в true? Скажи да или нет. [[LISTEN]]' });
    assert.deepEqual(db.writes, [], 'nothing written before the answer');
    // like ioBroker.assistant: time and weather in front of the words of the user
    assert.deepEqual(await ask(agent, 'Время: 14:52\n\nПогода: 12 °C\n\nДа.'), { answer: 'Лампа включена.' });
    assert.deepEqual(db.writes, [[LAMP, true]]);
    await stopAgent(agent);
});

test('any other answer is no: nothing is written and the model hears it', async () => {
    const f = await faux();
    let toolResult = '';
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: CONFIG(),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: LAMP, val: true }), { stopReason: 'toolUse' }),
            context => {
                toolResult = JSON.stringify(context.messages.at(-1));
                return f.fauxAssistantMessage('Хорошо, не включаю.');
            },
        ],
    });
    await ask(agent, 'Включи лампу');
    assert.deepEqual(await ask(agent, 'да, но сначала скажи температуру'), { answer: 'Хорошо, не включаю.' });
    assert.deepEqual(db.writes, []);
    assert.match(toolResult, /did not confirm writing 0_userdata\.0\.lamp \(no\)/);
    await stopAgent(agent);
});

test('no answer in time is no; the next ask is a new request', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: CONFIG(),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: LAMP, val: true }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Не подтверждено.'),
            f.fauxAssistantMessage('Новый ответ.'),
        ],
    });
    agent.textConfirmations.timeoutMs = 50;
    assert.match((await ask(agent, 'Включи лампу')).answer, /\[\[LISTEN\]\]$/);
    await waitFor(() => agent.logs.some(([, msg]) => /Confirmation by text for .* timeout/.test(msg)), 'the timeout');
    await waitFor(() => !agent.queues.size, 'the end of the request');
    assert.deepEqual(await ask(agent, 'да'), { answer: 'Новый ответ.' }, 'a late "yes" confirms nothing');
    assert.deepEqual(db.writes, []);
    await stopAgent(agent);
});

test('switched off: the write is blocked as before and the first ask gets the final answer', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: CONFIG(false),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('set_state', { id: LAMP, val: true }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Не могу подтвердить.'),
        ],
    });
    assert.deepEqual(await ask(agent, 'Включи лампу'), { answer: 'Не могу подтвердить.' });
    assert.deepEqual(db.writes, []);
    await stopAgent(agent);
});
