'use strict';

/**
 * Photos sent to a bot of the agent. The messenger adapters save them and name each file in communicate.pathFile, one
 * write per file; the caption arrives in communicate.request:
 *
 * - telegram writes the caption first and downloads the photos afterwards; without "save only quality" every photo
 *   arrives in up to four sizes (`<date>_low.jpg` … `<date>_highdef.jpg`, in an album
 *   `<date>_grpID_<group>_<count>_<quality>.jpg`, the count running over all sizes of all photos of the album);
 * - max publishes all photos of a message first, then its caption, one file per photo.
 *
 * The collector gathers the photos of a chat until no more arrive for a moment, together with their caption, and hands
 * them on as one question: only the largest size of each photo, and the caption, or else the next text of the chat
 * that follows within that moment ("what is this?").
 */

/** No more photos for this long: the message (or album) is complete. */
const PHOTO_QUIET_MS = 2000;

/** A telegram caption waits this long for its first photo, then it is answered alone. */
const CAPTION_WAIT_MS = 15000;

/** Sizes of a telegram photo, smallest first (qualityMap of the telegram adapter). */
const QUALITIES = ['low', 'med', 'high', 'highdef', 'none'];

const TELEGRAM_NAME = /^(.*?)(?:_grpID_(\d+)_(\d+))?_(low|med|high|highdef|none)\.jpg$/;

/**
 * Whether a file in communicate.pathFile is a photo (the "photo" folder of the messenger adapter).
 *
 * @param {string} filePath value of communicate.pathFile
 * @returns {boolean} true for a photo
 */
function isPhotoPath(filePath) {
    return /[\\/]photo[\\/][^\\/]+$/.test(filePath);
}

/**
 * The largest size of each photo, in the order they were sent. Files of the telegram pattern are grouped by photo:
 * one file per size of a single photo; in an album the sizes of one photo follow each other in the count, a smaller
 * size after a larger one starts the next photo. Any other file (max) is a photo of its own.
 *
 * @param {string[]} files paths in the order they arrived
 * @returns {string[]} one path per photo
 */
function largestPhotos(files) {
    const groups = new Map();
    files.forEach((file, at) => {
        const name = file.split(/[\\/]/).pop() || '';
        const m = TELEGRAM_NAME.exec(name);
        // "<name>#" a single photo, "<name>#<group>" an album, "<n>:#" a file of another pattern (one photo)
        const key = m ? `${m[1]}#${m[2] ?? ''}` : `${at}:#`;
        const count = m && m[3] !== undefined ? Number(m[3]) : 0;
        const rank = m ? QUALITIES.indexOf(m[4]) : 0;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)?.push({ file, count, rank, at });
    });
    // messages in the order their first file arrived; the photos of an album in the order they were sent
    const ordered = [...groups.entries()].sort(
        ([, a], [, b]) => Math.min(...a.map(e => e.at)) - Math.min(...b.map(e => e.at)),
    );
    const chosen = [];
    for (const [key, entries] of ordered) {
        if (key.endsWith('#')) {
            // a single photo (or a file of max): every file is a size of it
            chosen.push(entries.reduce((a, b) => (b.rank > a.rank ? b : a)).file);
            continue;
        }
        // an album: the sizes of one photo are consecutive in the count, smallest first
        entries.sort((a, b) => a.count - b.count);
        let best = entries[0];
        for (let i = 1; i < entries.length; i++) {
            const e = entries[i];
            if (e.rank <= entries[i - 1].rank) {
                chosen.push(best.file);
                best = e;
            } else if (e.rank > best.rank) {
                best = e;
            }
        }
        chosen.push(best.file);
    }
    return chosen;
}

/**
 * Gathers photos and captions per chat (see the top of the file). A complete message has: instance and chat, the id
 * of its first message (photo or caption), the files as they arrived (all sizes), the caption or following text ('' for
 * none) and `waited`, true when a caption waited in vain for its photos.
 */
class PhotoCollector {
    /**
     * @param {(message: { instance: string, chatId: string, messageId: unknown, files: string[], text: string, waited: boolean }) => void} onReady called with a complete message
     * @param {{ setTimeout(fn: () => void, ms: number): unknown, clearTimeout(timer: unknown): void }} timers timers of the adapter (stopped on unload)
     * @param {{ quietMs?: number, captionWaitMs?: number }} [options] waiting times, for tests
     */
    constructor(onReady, timers, options = {}) {
        this.onReady = onReady;
        this.timers = timers;
        this.quietMs = options.quietMs ?? PHOTO_QUIET_MS;
        this.captionWaitMs = options.captionWaitMs ?? CAPTION_WAIT_MS;
        // open messages by "<instance>/<chat>"
        this.open = new Map();
    }

    /**
     * A photo arrived.
     *
     * @param {string} instance messenger instance
     * @param {string} chatId chat
     * @param {unknown} messageId message id of the photo
     * @param {string} file path of the file
     */
    addPhoto(instance, chatId, messageId, file) {
        const entry = this.entry(instance, chatId, messageId);
        entry.files.push(file);
        this.schedule(entry, this.quietMs);
    }

    /**
     * A telegram caption of a message with photos: it waits for them.
     *
     * @param {string} instance messenger instance
     * @param {string} chatId chat
     * @param {unknown} messageId message id
     * @param {string} text caption
     */
    holdCaption(instance, chatId, messageId, text) {
        const entry = this.entry(instance, chatId, messageId);
        entry.text = entry.text ? `${entry.text}\n${text}` : text;
        this.schedule(entry, entry.files.length ? this.quietMs : this.captionWaitMs);
    }

    /**
     * A text of a chat with photos waiting for their caption (max sends it after the photos) becomes their caption.
     *
     * @param {string} instance messenger instance
     * @param {string} chatId chat
     * @param {string} text the text
     * @returns {boolean} true when the text went to the photos
     */
    takeText(instance, chatId, text) {
        const entry = this.open.get(`${instance}/${chatId}`);
        if (!entry || !entry.files.length || entry.text) {
            return false;
        }
        entry.text = text;
        this.flush(entry);
        return true;
    }

    /** Forget everything that waits (unload). */
    stop() {
        for (const entry of this.open.values()) {
            this.timers.clearTimeout(entry.timer);
        }
        this.open.clear();
    }

    /**
     * @param {string} instance messenger instance
     * @param {string} chatId chat
     * @param {unknown} messageId message id
     * @returns {{ instance: string, chatId: string, messageId: unknown, files: string[], text: string, waited: boolean, timer?: unknown }} the open message of the chat, a new one if none
     */
    entry(instance, chatId, messageId) {
        const key = `${instance}/${chatId}`;
        let entry = this.open.get(key);
        if (!entry) {
            entry = { instance, chatId, messageId, files: [], text: '', waited: false };
            this.open.set(key, entry);
        }
        return entry;
    }

    /**
     * @param {{ instance: string, chatId: string, messageId: unknown, files: string[], text: string, waited: boolean, timer?: unknown }} entry open message
     * @param {number} ms time to wait
     */
    schedule(entry, ms) {
        this.timers.clearTimeout(entry.timer);
        entry.timer = this.timers.setTimeout(() => {
            entry.waited = !entry.files.length;
            this.flush(entry);
        }, ms);
    }

    /** @param {{ instance: string, chatId: string, messageId: unknown, files: string[], text: string, waited: boolean, timer?: unknown }} entry open message */
    flush(entry) {
        this.timers.clearTimeout(entry.timer);
        this.open.delete(`${entry.instance}/${entry.chatId}`);
        const { instance, chatId, messageId, files, text, waited } = entry;
        this.onReady({ instance, chatId, messageId, files, text, waited });
    }
}

module.exports = { PHOTO_QUIET_MS, CAPTION_WAIT_MS, isPhotoPath, largestPhotos, PhotoCollector };
