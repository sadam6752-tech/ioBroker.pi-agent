'use strict';

// Pictures in an "ask" (ioBroker.assistant passes on the photos of Telegram): they reach the model as image blocks,
// the pending list keeps only the text, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent } = require('./helpers/agent-harness');
const { historyOf } = require('../lib/admin-chat');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-images-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');

/**
 * "ask" of ioBroker.assistant; returns what its callback got.
 *
 * @param {object} agent the started adapter
 * @param {object} message the message
 */
async function ask(agent, message) {
    await agent.onMessage({
        command: 'ask',
        message: { conversation: 'telegram:Max', ...message },
        from: 'system.adapter.assistant.0',
        callback: 'cb',
    });
    return agent.sent.at(-1)[2];
}

test('pictures go to the model as image blocks after the text', async () => {
    const f = await faux();
    let seen;
    let pendingDuringRequest;
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            context => {
                seen = context.messages.at(-1).content;
                pendingDuringRequest = agent.pending.map(p => p.content);
                return f.fauxAssistantMessage('Eine Katze.');
            },
        ],
    });
    const answer = await ask(agent, {
        text: 'Was ist das?',
        images: [
            { data: JPEG, mimeType: 'image/jpeg' },
            { data: 'JVBERi0=', mimeType: 'application/pdf' },
        ],
    });
    assert.deepEqual(answer, { answer: 'Eine Katze.' });
    assert.deepEqual(seen, [
        { type: 'text', text: 'Was ist das?' },
        { type: 'image', data: JPEG, mimeType: 'image/jpeg' },
    ]);
    // no base64 in the state chat.pending
    assert.deepEqual(pendingDuringRequest, ['[picture] Was ist das?']);
    await stopAgent(agent);
});

test('pictures without text are a request; without both it is refused', async () => {
    const f = await faux();
    let seen;
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            context => {
                seen = context.messages.at(-1).content;
                return f.fauxAssistantMessage('Ein Garten.');
            },
        ],
    });
    assert.deepEqual(await ask(agent, { images: [{ data: JPEG, mimeType: 'image/jpeg' }] }), {
        answer: 'Ein Garten.',
    });
    assert.deepEqual(seen, [{ type: 'image', data: JPEG, mimeType: 'image/jpeg' }]);

    assert.deepEqual(await ask(agent, { images: [{ data: 'JVBERi0=', mimeType: 'application/pdf' }] }), {
        error: 'Missing "text"',
    });
    await stopAgent(agent);
});

test('the type comes from the content; too large, unknown and a fifth picture are dropped with a warning', async () => {
    const f = await faux();
    let seen;
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            context => {
                seen = context.messages.at(-1).content;
                return f.fauxAssistantMessage('Gesehen.');
            },
        ],
    });
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const huge = JPEG + 'A'.repeat(5 * 1024 * 1024);
    const answer = await ask(agent, {
        text: 'Was ist das?',
        images: [
            { data: `data:image/png;base64,${PNG}`, mimeType: 'image/jpeg' }, // wrong type named, data URL
            { data: huge, mimeType: 'image/jpeg' },
            { data: 'JVBERi0=', mimeType: 'image/jpeg' }, // a PDF named a JPEG
            { data: JPEG, mimeType: 'image/jpeg' },
            { data: JPEG, mimeType: 'image/jpeg' },
            { data: JPEG, mimeType: 'image/jpeg' },
            { data: JPEG, mimeType: 'image/jpeg' },
        ],
    });
    assert.deepEqual(answer, { answer: 'Gesehen.' });
    assert.deepEqual(
        seen.slice(1).map(b => b.mimeType),
        ['image/png', 'image/jpeg', 'image/jpeg', 'image/jpeg'],
    );
    assert.equal(seen[1].data, PNG);
    const warning = agent.logs.find(([lvl, m]) => lvl === 'warn' && m.includes('not sent to the model'));
    assert.match(warning[1], /picture 2: larger than 3\.9 MB; picture 3: no JPEG.*; picture 7: more than 4 pictures/);
    await stopAgent(agent);
});

test('the admin page shows a mark for the pictures', () => {
    const messages = historyOf([
        {
            kind: 'pi.user',
            model: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Was ist das?' },
                        { type: 'image', data: JPEG, mimeType: 'image/jpeg' },
                        { type: 'image', data: JPEG, mimeType: 'image/jpeg' },
                    ],
                    timestamp: 1,
                },
            ],
        },
    ]);
    assert.equal(messages[0].text, '[2 pictures] Was ist das?');
});
