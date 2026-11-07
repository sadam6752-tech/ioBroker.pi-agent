'use strict';

// Photos sent to a bot (lib/photos.js and the path in main.js): the largest size of each photo, the caption before
// (telegram) or after (max) the photos, a question right after photos, the column "Photos" and the hints.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');
const { largestPhotos, PhotoCollector, isPhotoPath } = require('../lib/photos');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-photos-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const TG = 'telegram.0';
const MAX = 'max.0';
const USERS = JSON.stringify({ 1: { firstName: 'Alex', userName: 'alex' } });

/** A JPEG of its own per name, so the test can tell which file reached the model. */
const jpeg = name => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(name)]);
const base64 = name => jpeg(name).toString('base64');

test('largestPhotos: the largest size per photo, albums split by size, other files one each', () => {
    const dir = '/opt/iobroker/iobroker-data/telegram_0/photo/';
    assert.deepEqual(
        largestPhotos([`${dir}d1_low.jpg`, `${dir}d1_highdef.jpg`, `${dir}d1_med.jpg`, `${dir}d1_high.jpg`]),
        [`${dir}d1_highdef.jpg`],
    );
    // an album of two photos, the second with three sizes only, downloads finishing in any order
    const album = [
        'd2_grpID_0_4_low.jpg',
        'd2_grpID_0_1_med.jpg',
        'd2_grpID_0_0_low.jpg',
        'd2_grpID_0_6_high.jpg',
        'd2_grpID_0_3_highdef.jpg',
        'd2_grpID_0_2_high.jpg',
        'd2_grpID_0_5_med.jpg',
    ].map(n => dir + n);
    assert.deepEqual(largestPhotos(album), [`${dir}d2_grpID_0_3_highdef.jpg`, `${dir}d2_grpID_0_6_high.jpg`]);
    // "save only quality": one size per photo
    assert.deepEqual(largestPhotos([`${dir}d3_grpID_1_0_high.jpg`, `${dir}d3_grpID_1_1_high.jpg`]), [
        `${dir}d3_grpID_1_0_high.jpg`,
        `${dir}d3_grpID_1_1_high.jpg`,
    ]);
    // max: one file per photo
    assert.deepEqual(largestPhotos(['/x/photo/m1_1.jpg', '/x/photo/m1_2.jpg']), [
        '/x/photo/m1_1.jpg',
        '/x/photo/m1_2.jpg',
    ]);
    assert.ok(isPhotoPath('C:\\data\\telegram_0\\photo\\a_low.jpg'));
    assert.ok(!isPhotoPath('/data/telegram_0/voice/a.ogg'));
});

test('PhotoCollector: caption first waits for the photos, a text after photos is their caption', async () => {
    const ready = [];
    const collector = new PhotoCollector(m => ready.push(m), globalThis, { quietMs: 30, captionWaitMs: 80 });
    collector.holdCaption(TG, '100', 5, 'Was ist das?');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(ready.length, 0, 'the caption waits longer than the quiet time');
    collector.addPhoto(TG, '100', 5, 'a.jpg');
    collector.addPhoto(TG, '100', 5, 'b.jpg');
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(ready, [
        { instance: TG, chatId: '100', messageId: 5, files: ['a.jpg', 'b.jpg'], text: 'Was ist das?', waited: false },
    ]);

    collector.addPhoto(MAX, 'u9', 6, 'c.jpg');
    assert.equal(collector.takeText(MAX, 'other', 'hi'), false, 'another chat is not affected');
    assert.equal(collector.takeText(MAX, 'u9', 'Und das?'), true);
    assert.equal(ready[1].text, 'Und das?');
    assert.equal(collector.takeText(MAX, 'u9', 'next'), false, 'only one text per photo message');

    collector.holdCaption(TG, '100', 7, 'Foto?');
    await new Promise(r => setTimeout(r, 120));
    assert.deepEqual(ready[2], {
        instance: TG,
        chatId: '100',
        messageId: 7,
        files: [],
        text: 'Foto?',
        waited: true,
    });
    collector.stop();
});

/**
 * Start the agent with a telegram row; the photo waits are short for the test.
 *
 * @param {object} row the messenger row
 * @param {Array<Function>} responses model answers
 * @param {object} [native] settings of the stand-in telegram instance
 */
async function start(row, responses, native = { saveFiles: true, storeRawRequest: true, deleteFilesAfterDays: 7 }) {
    const dataDir = tmp();
    const started = await startAgent({
        dataDir,
        config: { messengers: [{ enabled: true, users: '1, 9', prefix: '/ai', ...row }] },
        seed: { objects: { [`system.adapter.${row.instance}`]: { type: 'instance', common: {}, native } } },
        responses,
    });
    started.agent.photos.quietMs = 30;
    started.agent.photos.captionWaitMs = 100;
    fs.mkdirSync(path.join(dataDir, 'photo'));
    return { ...started, dataDir };
}

/** Request ids of a message as the messenger adapter writes them. */
function ids(db, instance, { chatId, userId, messageId, raw }) {
    const ts = Date.now();
    db.setState(`${instance}.communicate.requestChatId`, { val: chatId, ack: true, ts });
    db.setState(`${instance}.communicate.requestUserId`, { val: userId, ack: true, ts });
    db.setState(`${instance}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    db.setState(`${instance}.communicate.users`, { val: USERS, ack: true, ts });
    if (raw !== undefined) {
        db.setState(`${instance}.communicate.requestRaw`, { val: JSON.stringify(raw), ack: true, ts });
    }
}

const text = (agent, instance, name, value) =>
    agent.onStateChange(`${instance}.communicate.request`, { val: `[${name}]${value}`, ack: true, ts: Date.now() });

/** A photo file saved by the messenger adapter and named in communicate.pathFile. */
async function photo(agent, dataDir, instance, name) {
    const file = path.join(dataDir, 'photo', name);
    fs.writeFileSync(file, jpeg(name));
    await agent.onStateChange(`${instance}.communicate.pathFile`, { val: file, ack: true, ts: Date.now() });
}

const sent = (agent, instance) => agent.sent.filter(([to]) => to === instance).map(([, , msg]) => msg.text);

test('telegram: the caption waits for its photos, only the largest size goes to the model, without the prefix', async () => {
    const f = await faux();
    const seen = [];
    const { agent, db, dataDir } = await start({ instance: TG, photos: true }, [
        context => {
            seen.push(context.messages.at(-1).content);
            return f.fauxAssistantMessage('Eine Katze.<picture-notes>graue Katze auf dem Sofa</picture-notes>');
        },
    ]);
    assert.deepEqual(agent.foreignSubscriptions, [`${TG}.communicate.request`, `${TG}.communicate.pathFile`]);
    assert.ok(agent.logs.some(([, m]) => m.includes('photos on telegram.0 go to the model')));

    ids(db, TG, { chatId: 100, userId: 1, messageId: 40, raw: { message_id: 40, photo: [{}, {}], caption: 'x' } });
    await text(agent, TG, 'Alex', '/ai Was ist das?');
    assert.deepEqual(sent(agent, TG), [], 'no answer before the photos');
    await photo(agent, dataDir, TG, 'd_low.jpg');
    await photo(agent, dataDir, TG, 'd_high.jpg');
    await waitFor(() => sent(agent, TG).length === 1, 'the answer');

    assert.deepEqual(sent(agent, TG), ['Eine Katze.'], 'the notes are not shown');
    assert.deepEqual(seen[0].slice(0, 2), [
        { type: 'text', text: 'Was ist das?' },
        { type: 'image', data: base64('d_high.jpg'), mimeType: 'image/jpeg' },
    ]);
    assert.equal(seen[0].filter(b => b.type === 'image').length, 1);
    await stopAgent(agent);
});

test('telegram: a question right after photos without caption; a text without photos is answered at once', async () => {
    const f = await faux();
    const seen = [];
    const reply = answer => context => {
        seen.push(context.messages.at(-1).content);
        return f.fauxAssistantMessage(answer);
    };
    const { agent, db, dataDir } = await start({ instance: TG, photos: true, prefix: '' }, [
        reply('Ein Zähler.'),
        reply('Hallo.'),
    ]);
    ids(db, TG, { chatId: 100, userId: 1, messageId: 50, raw: { message_id: 50, photo: [{}] } });
    await photo(agent, dataDir, TG, 'e_med.jpg');
    ids(db, TG, { chatId: 100, userId: 1, messageId: 51, raw: { message_id: 51, text: 'Wie viel?' } });
    await text(agent, TG, 'Alex', 'Wie viel?');
    await waitFor(() => sent(agent, TG).length === 1, 'the answer to the photo');
    assert.deepEqual(seen[0].slice(0, 2), [
        { type: 'text', text: 'Wie viel?' },
        { type: 'image', data: base64('e_med.jpg'), mimeType: 'image/jpeg' },
    ]);

    ids(db, TG, { chatId: 100, userId: 1, messageId: 52, raw: { message_id: 52, text: 'Hallo' } });
    await text(agent, TG, 'Alex', 'Hallo');
    assert.deepEqual(sent(agent, TG), ['Ein Zähler.', 'Hallo.']);
    await stopAgent(agent);
});

test('telegram: photos of a refused sender are dropped; a caption without photos is answered alone', async () => {
    const f = await faux();
    const seen = [];
    const { agent, db, dataDir } = await start({ instance: TG, photos: true }, [
        context => {
            seen.push(context.messages.at(-1).content);
            return f.fauxAssistantMessage('Ohne Foto.');
        },
    ]);
    ids(db, TG, { chatId: 300, userId: 3, messageId: 60, raw: { message_id: 60, photo: [{}] } });
    await photo(agent, dataDir, TG, 'f_high.jpg');
    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(sent(agent, TG), []);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('user not allowed')));

    ids(db, TG, { chatId: 100, userId: 1, messageId: 61, raw: { message_id: 61, photo: [{}], caption: 'Und?' } });
    await text(agent, TG, 'Alex', 'Und?');
    await waitFor(() => sent(agent, TG).length === 1, 'the answer to the caption');
    assert.equal(seen[0], 'Und?');
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('the photos of a message did not arrive')));
    await stopAgent(agent);
});

test('max: the photos first, then the caption, as one question', async () => {
    const f = await faux();
    const seen = [];
    const { agent, db, dataDir } = await start({ instance: MAX, photos: true }, [
        context => {
            seen.push(context.messages.at(-1).content);
            return f.fauxAssistantMessage('Zwei Fotos.');
        },
    ]);
    ids(db, MAX, { chatId: 0, userId: 9, messageId: 'mid.1' });
    await photo(agent, dataDir, MAX, 'mid.1_1.jpg');
    await photo(agent, dataDir, MAX, 'mid.1_2.jpg');
    await text(agent, MAX, '9', 'Was ist darauf?');
    await waitFor(() => sent(agent, MAX).length === 1, 'the answer');
    assert.deepEqual(seen[0][0], { type: 'text', text: 'Was ist darauf?' });
    assert.deepEqual(
        seen[0].filter(b => b.type === 'image').map(b => b.data),
        [base64('mid.1_1.jpg'), base64('mid.1_2.jpg')],
    );
    await stopAgent(agent);
});

test('"Photos" off (and rows saved before 0.9.6): photos are not read; telegram hints at its settings', async () => {
    const off = await start({ instance: TG }, []);
    assert.deepEqual(off.agent.foreignSubscriptions, [`${TG}.communicate.request`]);
    await stopAgent(off.agent);

    const noSave = await start({ instance: TG, photos: true }, [], { saveFiles: false });
    assert.ok(
        noSave.agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('"Save files" in its settings is off')),
    );
    await stopAgent(noSave.agent);

    const noRaw = await start({ instance: TG, photos: true }, [], { saveFiles: true, deleteFilesAfterDays: 7 });
    assert.ok(
        noRaw.agent.logs.some(
            ([lvl, m]) =>
                lvl === 'warn' && m.includes('"Remember raw request data" on the tab Messages of its settings is off'),
        ),
    );
    await stopAgent(noRaw.agent);

    const keep = await start({ instance: TG, photos: true }, [], {
        saveFiles: true,
        storeRawRequest: true,
        deleteFilesAfterDays: 0,
    });
    assert.ok(keep.agent.logs.some(([lvl, m]) => lvl === 'info' && m.includes('keeps received photos for ever')));
    await stopAgent(keep.agent);
});
