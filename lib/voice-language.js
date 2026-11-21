'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The language of the voice messages per messenger chat. A model like Canary needs the language told: one fixed
 * language turns speech in another into a translation, or into nothing. The user sends "ru", "de", "en" (or "/ru",
 * also "/ru@bot" from the command menu of telegram) as a message of its own, and the voice messages of that chat
 * are recognized in it until the next such message. Without one the language of the settings applies.
 *
 * The file survives restarts.
 */

const FILE = 'voice-languages.json';
/** Chats kept; the ones changed least recently are dropped first. */
const MAX_CHATS = 200;
/** "ru", "/ru", "/RU@my_bot" */
const COMMAND = /^\/?([a-z]{2})(?:@\w+)?$/i;
/**
 * The languages a command may name: those of Canary 1B v2 (Whisper knows them too). Not every ISO code: "hi" (Hindi)
 * or "no" (Norwegian) sent as a greeting or an answer must stay a message for the agent.
 */
const LANGUAGES = new Set('bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk'.split(' '));

/**
 * The language a message switches to, or "" when it is not such a command.
 *
 * @param {unknown} text message text
 * @returns {string} ISO 639-1 code, e.g. "ru"
 */
function languageCommand(text) {
    const code = COMMAND.exec(String(text ?? '').trim())?.[1]?.toLowerCase();
    return code && LANGUAGES.has(code) ? code : '';
}

/**
 * The name of a language in itself, e.g. "русский", "Deutsch".
 *
 * @param {string} code ISO 639-1 code
 * @returns {string} name, or the code when it names no language
 */
function languageName(code) {
    try {
        return new Intl.DisplayNames([code], { type: 'language', fallback: 'code' }).of(code) || code;
    } catch {
        return code;
    }
}

/**
 * @param {string} dir instance data directory ("" in tests: nothing is written)
 * @returns {{ load: () => void, get: (instance: string, chatId: unknown) => string, set: (instance: string, chatId: unknown, code: string) => void }} languages of the chats
 */
function createVoiceLanguages(dir) {
    const file = dir ? path.join(dir, FILE) : '';
    /** "telegram.0/100" -> "ru"; the order of the map is the order of the last change */
    let chats = new Map();
    const key = (instance, chatId) => `${instance}/${String(chatId ?? '')}`;

    return {
        /** Read the file; an unreadable one starts empty. */
        load() {
            chats = new Map();
            if (!file) {
                return;
            }
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const [chat, code] of Object.entries(data && typeof data === 'object' ? data : {})) {
                    if (typeof code === 'string' && languageCommand(code)) {
                        chats.set(chat, code);
                    }
                }
            } catch {
                // no file yet, or a broken one: the language of the settings applies
            }
        },
        get(instance, chatId) {
            return chats.get(key(instance, chatId)) || '';
        },
        set(instance, chatId, code) {
            const k = key(instance, chatId);
            chats.delete(k);
            chats.set(k, code);
            while (chats.size > MAX_CHATS) {
                chats.delete(chats.keys().next().value);
            }
            if (!file) {
                return;
            }
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify(Object.fromEntries(chats)));
            } catch {
                // the choice holds until the next restart
            }
        },
    };
}

module.exports = { languageCommand, languageName, createVoiceLanguages };
