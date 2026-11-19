'use strict';

// The language of an answer for a caller that speaks it (ioBroker.assistant): the rule in the instructions, the mark
// [[lang:xx]] taken out of the answer and returned as `language`, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent } = require('./helpers/agent-harness');
const {
    LANGUAGE_RULE,
    LANGUAGE_REMINDER,
    withLanguageRule,
    withLanguageReminder,
    takeLanguage,
    scriptLanguage,
} = require('../lib/answer-language');
const { historyOf } = require('../lib/admin-chat');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-lang-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

/**
 * "ask" of ioBroker.assistant; returns what its callback got.
 *
 * @param {object} agent the started adapter
 * @param {object} message the message
 */
async function ask(agent, message) {
    await agent.onMessage({
        command: 'ask',
        message: { conversation: 'Gast', ...message },
        from: 'system.adapter.assistant.0',
        callback: 'cb',
    });
    return agent.sent.at(-1)[2];
}

test('takeLanguage removes the mark and returns its code', () => {
    assert.deepEqual(takeLanguage('Свет включён. [[lang:ru]]'), { text: 'Свет включён.', language: 'ru' });
    assert.deepEqual(takeLanguage('Das Licht ist an.\n[[ LANG = DE ]]'), { text: 'Das Licht ist an.', language: 'de' });
    // [[LISTEN]] of a question stays at the end
    assert.deepEqual(takeLanguage('Welche Lampe? [[lang:de]] [[LISTEN]]'), {
        text: 'Welche Lampe? [[LISTEN]]',
        language: 'de',
    });
    assert.deepEqual(takeLanguage('No mark.'), { text: 'No mark.', language: '' });
    assert.deepEqual(takeLanguage('[[lang:zh-cn]] 好'), { text: '好', language: 'zh-cn' });
    assert.equal(withLanguageRule(''), LANGUAGE_RULE);
    assert.equal(
        withLanguageReminder('Hi'),
        `Hi

${LANGUAGE_REMINDER}`,
    );
    assert.deepEqual(withLanguageReminder([{ type: 'image' }]), [
        { type: 'image' },
        { type: 'text', text: LANGUAGE_REMINDER },
    ]);
    assert.equal(scriptLanguage('Тестовая лампа включена.'), 'ru');
    assert.equal(scriptLanguage('Світло ввімкнено.'), 'uk');
    assert.equal(scriptLanguage('灯已打开。'), 'zh');
    assert.equal(scriptLanguage('Die Lampe „Торшер“ ist an.'), '');
    assert.equal(withLanguageRule('Short.'), `Short.\n\n${LANGUAGE_RULE}`);
});

test('a caller with language gets the rule and the language of the answer', async () => {
    const f = await faux();
    let prompt = '';
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            ctx => {
                prompt = JSON.stringify(ctx);
                return f.fauxAssistantMessage('Свет в гостиной включён. [[lang:ru]]');
            },
            f.fauxAssistantMessage('Without a mark.'),
            ctx => {
                prompt = JSON.stringify(ctx);
                return f.fauxAssistantMessage('Тестовая лампа включена.');
            },
        ],
    });
    const result = await ask(agent, {
        text: 'Включи свет',
        language: 'de',
        instructions: 'Answer in one short sentence.',
    });
    assert.deepEqual(result, { answer: 'Свет в гостиной включён.', language: 'ru' });
    assert.ok(prompt.includes('Answer in one short sentence.'), 'the own instructions stay');
    assert.ok(prompt.includes('[[lang:xx]]'), 'the rule is in the instructions');
    // a model that forgets the mark: no field, the caller falls back to its own guess
    assert.deepEqual(await ask(agent, { text: 'and now?', language: 'de' }), { answer: 'Without a mark.' });
    // without a mark the letters tell Russian; the question carries the reminder
    assert.deepEqual(await ask(agent, { text: 'А лампа?', language: 'de' }), {
        answer: 'Тестовая лампа включена.',
        language: 'ru',
    });
    assert.ok(prompt.includes('А лампа?\\n\\n(End your answer with [[lang:xx]]'), 'the reminder follows the question');
    await stopAgent(agent);
});

test('a caller without language gets no rule', async () => {
    const f = await faux();
    let prompt = '';
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            ctx => {
                prompt = JSON.stringify(ctx);
                return f.fauxAssistantMessage('Hallo');
            },
        ],
    });
    assert.deepEqual(await ask(agent, { text: 'Hallo', instructions: 'Short.' }), { answer: 'Hallo' });
    assert.ok(!prompt.includes('[[lang:xx]]'), 'neither the rule nor the reminder');
    await stopAgent(agent);
});

test('the admin chat shows an answer without the mark', () => {
    const entries = [
        { kind: 'pi.user', model: [{ role: 'user', content: 'Привет', timestamp: 1 }] },
        {
            kind: 'pi.assistant',
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Привет! [[lang:ru]]' }], timestamp: 2 }],
        },
    ];
    const shown = JSON.stringify(historyOf(entries));
    assert.ok(shown.includes('Привет!'));
    assert.ok(!shown.includes('[[lang'));
});
