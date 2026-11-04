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
const { PICTURE_GONE, PICTURE_REMOVED, trimStoredPictures } = require('../lib/pictures');

/** The request for picture notes that the newest message with pictures gets (lib/pictures.js). */
const notesRequest = block => block.type === 'text' && block.text.includes('<picture-notes>');

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
    assert.deepEqual(seen.slice(0, 2), [
        { type: 'text', text: 'Was ist das?' },
        { type: 'image', data: JPEG, mimeType: 'image/jpeg' },
    ]);
    assert.ok(notesRequest(seen[2]));
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
    assert.deepEqual(seen[0], { type: 'image', data: JPEG, mimeType: 'image/jpeg' });
    assert.ok(notesRequest(seen[1]));

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
        seen.slice(1, -1).map(b => b.mimeType),
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

test('a picture goes to the model once: later requests get a text and the notes; the user never sees the notes', async () => {
    const f = await faux();
    const seen = [];
    const { agent } = await startAgent({
        dataDir: tmp(),
        responses: [
            context => {
                seen.push(context.messages);
                return f.fauxAssistantMessage('Eine Katze.\n<picture-notes>graue Katze auf rotem Sofa</picture-notes>');
            },
            context => {
                seen.push(context.messages);
                return f.fauxAssistantMessage('Rot.');
            },
        ],
    });
    assert.deepEqual(await ask(agent, { text: 'Was ist das?', images: [{ data: JPEG, mimeType: 'image/jpeg' }] }), {
        answer: 'Eine Katze.',
    });
    assert.deepEqual(await ask(agent, { text: 'Welche Farbe hat das Sofa?' }), { answer: 'Rot.' });
    const second = JSON.stringify(seen[1]);
    assert.doesNotMatch(second, /"type":"image"/, 'the picture is not sent again');
    assert.ok(second.includes(PICTURE_GONE.slice(0, 30)));
    assert.match(second, /graue Katze auf rotem Sofa/, 'the notes stay in the history');
    assert.doesNotMatch(second, /Do not mention them/, 'the request for notes was only for the first request');
    await stopAgent(agent);
});

test('the admin page does not show the notes', () => {
    const messages = historyOf([
        { kind: 'pi.user', model: [{ role: 'user', content: 'x', timestamp: 1 }] },
        {
            kind: 'pi.assistant',
            model: [
                {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Eine Katze.\n<picture-notes>grau</picture-notes>' }],
                    timestamp: 2,
                },
            ],
        },
    ]);
    const answer = messages.find(m => m.role === 'assistant');
    assert.doesNotMatch(answer.html, /picture-notes|grau/);
});

test('the store keeps only the newest pictures; an unknown schema is not touched', () => {
    const { DatabaseSync } = require('node:sqlite');
    const dir = tmp();
    const db = new DatabaseSync(path.join(dir, 'session.sqlite'));
    db.exec('CREATE TABLE durable_schema (singleton INTEGER, version INTEGER)');
    db.exec('INSERT INTO durable_schema VALUES (1, 2)');
    db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT)');
    const insert = db.prepare('INSERT INTO entries VALUES (?, ?)');
    const picture = n => ({ type: 'image', data: `${JPEG}${n}`, mimeType: 'image/jpeg' });
    insert.run(1, JSON.stringify({ kind: 'pi.user', model: [{ role: 'user', content: [picture(1), picture(2)] }] }));
    insert.run(2, JSON.stringify({ kind: 'pi.assistant', model: [{ role: 'assistant', content: 'ok' }] }));
    insert.run(
        3,
        JSON.stringify({
            kind: 'pi.user',
            model: [{ role: 'user', content: [{ type: 'text', text: 'a' }, picture(3)] }],
        }),
    );
    db.close();

    assert.deepEqual(trimStoredPictures(dir, { keep: 2 }), { removed: 1 });
    const read = () => {
        const store = new DatabaseSync(path.join(dir, 'session.sqlite'));
        const rows = store.prepare('SELECT id, record FROM entries ORDER BY id').all();
        store.close();
        return rows.map(r => JSON.parse(String(r.record)).model[0].content);
    };
    const [first, , third] = read();
    assert.deepEqual(first, [{ type: 'text', text: PICTURE_REMOVED }, picture(2)], 'the oldest picture went');
    assert.deepEqual(third[1], picture(3));
    assert.deepEqual(trimStoredPictures(dir, { keep: 2 }), { removed: 0 }, 'nothing more to do');

    const other = new DatabaseSync(path.join(dir, 'session.sqlite'));
    other.exec('UPDATE durable_schema SET version = 3');
    other.close();
    assert.match(String(trimStoredPictures(dir, { keep: 0 }).skipped), /schema version 3/);
    assert.deepEqual(read()[1 + 1][1], picture(3), 'unchanged');
});
