'use strict';

/**
 * Pictures in conversations (ioBroker.assistant passes on the photos of Telegram through "ask").
 *
 * A picture goes to the model only with the request of its own message. In that request the model is asked to write
 * what the picture shows into <picture-notes> after its answer; the notes stay in the history, the user does not see
 * them. Later requests get a text in place of the picture that points to those notes (or, when the model wrote none,
 * to its answer). So a picture costs its tokens
 * once, and a picture the provider refuses blocks only its own request.
 *
 * In the store only the newest pictures are kept: at the start, before the store is opened, older ones are replaced
 * by a text (the same safety rules as lib/purge.js: only with the known schema version, in one transaction).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Pictures kept in the store; older ones are removed at the next start. */
const MAX_STORED_PICTURES = 20;

/** Version of the SQLite schema of Pi Durable the statements below are written for (as in lib/purge.js). */
const SCHEMA_VERSION = 2;

const NOTES = /<picture-notes>[\s\S]*?(<\/picture-notes>|$)/g;

const NOTES_REQUEST =
    'After your answer, write what the picture(s) above show in <picture-notes>…</picture-notes>: objects, people, ' +
    'text and numbers that can be read, colors, the scene. Later questions do not get the picture again, only these ' +
    'notes; the user does not see them. Do not mention them in your answer.';

const PICTURE_GONE =
    '[picture: not sent again; what it showed is in the <picture-notes> of your answer to this message]';

const PICTURE_SEEN =
    '[picture: you saw it when you answered this message, it is not sent again; your answer to it is all that is ' +
    'known of it now. It was sent: do not say you never got it]';

const PICTURE_REMOVED = '[picture removed from the store]';

/**
 * Whether the answer to the message at `index` (the assistant messages up to the next user message) has picture notes.
 *
 * @param {ReadonlyArray<{ role?: string, content?: unknown }>} messages messages of the request
 * @param {number} index index of the user message with the picture
 * @returns {boolean} true when the model wrote notes
 */
function answeredWithNotes(messages, index) {
    for (let i = index + 1; i < messages.length && messages[i]?.role !== 'user'; i++) {
        const content = messages[i]?.content;
        const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(b => b?.text) : [];
        if (texts.some(t => typeof t === 'string' && t.includes('<picture-notes>'))) {
            return true;
        }
    }
    return false;
}

/**
 * The messages of one model request: pictures only in the newest user message, which also gets the request for notes.
 *
 * @template {{ role?: string, content?: string | ReadonlyArray<{ type?: string }> }} M
 * @param {ReadonlyArray<M>} messages messages of the request
 * @returns {M[] | undefined} changed messages, undefined when nothing changes
 */
function picturesForRequest(messages) {
    let last = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            last = i;
            break;
        }
    }
    const hasPicture = m => m?.role === 'user' && Array.isArray(m.content) && m.content.some(b => b?.type === 'image');
    if (!messages.some(hasPicture)) {
        return undefined;
    }
    return messages.map((m, i) => {
        if (!hasPicture(m) || !Array.isArray(m.content)) {
            return m;
        }
        if (i === last) {
            return { ...m, content: [...m.content, { type: 'text', text: NOTES_REQUEST }] };
        }
        // a model that wrote no notes is not pointed to notes it cannot find
        const text = answeredWithNotes(messages, i) ? PICTURE_GONE : PICTURE_SEEN;
        return { ...m, content: m.content.map(b => (b?.type === 'image' ? { type: 'text', text } : b)) };
    });
}

/**
 * An answer without the picture notes, as the user gets it.
 *
 * @param {string} text answer
 * @returns {string} text
 */
function withoutPictureNotes(text) {
    return text.includes('<picture-notes>') ? text.replace(NOTES, '').trim() : text;
}

/**
 * Keep only the newest pictures in the store. Runs before the store is opened.
 *
 * @param {string} dir instance data directory
 * @param {{ keep?: number }} [options] keep: pictures to keep (default MAX_STORED_PICTURES)
 * @returns {{ removed: number, skipped?: string }} how many pictures were removed; `skipped` names why nothing was done
 */
function trimStoredPictures(dir, options = {}) {
    const keep = options.keep ?? MAX_STORED_PICTURES;
    const storeFile = path.join(dir, 'session.sqlite');
    if (!fs.existsSync(storeFile)) {
        return { removed: 0 };
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(storeFile);
    try {
        let version = 0;
        try {
            version = Number(
                Object(db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get()).version,
            );
        } catch {
            // no schema table: unknown version
        }
        if (version !== SCHEMA_VERSION) {
            return { removed: 0, skipped: `the store has schema version ${version || 0}, not ${SCHEMA_VERSION}` };
        }
        const rows = db
            .prepare(`SELECT id, record FROM entries WHERE record LIKE '%"type":"image"%' ORDER BY id DESC`)
            .all();
        let seen = 0;
        const changed = [];
        for (const row of rows) {
            let record;
            try {
                record = JSON.parse(String(row.record));
            } catch {
                continue;
            }
            let touched = false;
            // newest first, also within an entry
            for (const m of Array.isArray(record?.model) ? [...record.model].reverse() : []) {
                if (!Array.isArray(m?.content)) {
                    continue;
                }
                m.content = [...m.content]
                    .reverse()
                    .map(b => {
                        if (b?.type !== 'image') {
                            return b;
                        }
                        seen += 1;
                        if (seen <= keep) {
                            return b;
                        }
                        touched = true;
                        return { type: 'text', text: PICTURE_REMOVED };
                    })
                    .reverse();
            }
            if (touched) {
                changed.push({ id: row.id, record: JSON.stringify(record) });
            }
        }
        if (changed.length === 0) {
            return { removed: 0 };
        }
        const update = db.prepare('UPDATE entries SET record = ? WHERE id = ?');
        db.exec('BEGIN');
        try {
            for (const { id, record } of changed) {
                update.run(record, id);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        db.exec('VACUUM');
        return { removed: seen - keep };
    } finally {
        db.close();
    }
}

module.exports = {
    MAX_STORED_PICTURES,
    PICTURE_GONE,
    PICTURE_SEEN,
    PICTURE_REMOVED,
    picturesForRequest,
    trimStoredPictures,
    withoutPictureNotes,
};
