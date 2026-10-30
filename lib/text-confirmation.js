'use strict';

// Confirmation by text in sendTo conversations (e.g. ioBroker.assistant): the caller cannot show buttons, so the
// question goes back as the answer of its "ask", and its next "ask" in the same conversation decides. Only a plain
// "yes" word confirms; the decision never goes through the model.

/** Time the caller has for its answer; then the action is not done. */
const TEXT_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000;

/** Marker of ioBroker.assistant: open the microphone again after the answer is spoken. */
const LISTEN = '[[LISTEN]]';

/** "Yes" in the languages of the adapter; every one counts, whatever the system language. See isYes. */
const YES_WORDS = ['yes', 'ja', 'да', 'sim', 'oui', 'sì', 'si', 'sí', 'tak', 'так', '是', '是的', '好'];

/** The questions, spoken by a voice assistant: plain text, no Markdown, no emoji. */
const QUESTIONS = {
    en: {
        write: (what, val) => `Set ${what} to ${val}?`,
        sendTo: (what, val) => `Send the command ${val} to ${what}?`,
        restart: what => `Restart the instance ${what}?`,
        update: (what, val) => `Update the adapter ${what}, ${val}?`,
        answer: 'Say yes or no.',
    },
    de: {
        write: (what, val) => `${what} auf ${val} setzen?`,
        sendTo: (what, val) => `Den Befehl ${val} an ${what} senden?`,
        restart: what => `Die Instanz ${what} neu starten?`,
        update: (what, val) => `Den Adapter ${what} aktualisieren, ${val}?`,
        answer: 'Sag ja oder nein.',
    },
    ru: {
        write: (what, val) => `Установить ${what} в ${val}?`,
        sendTo: (what, val) => `Отправить команду ${val} в ${what}?`,
        restart: what => `Перезапустить инстанс ${what}?`,
        update: (what, val) => `Обновить адаптер ${what}, ${val}?`,
        answer: 'Скажи да или нет.',
    },
    pt: {
        write: (what, val) => `Definir ${what} como ${val}?`,
        sendTo: (what, val) => `Enviar o comando ${val} para ${what}?`,
        restart: what => `Reiniciar a instância ${what}?`,
        update: (what, val) => `Atualizar o adaptador ${what}, ${val}?`,
        answer: 'Diga sim ou não.',
    },
    nl: {
        write: (what, val) => `${what} op ${val} zetten?`,
        sendTo: (what, val) => `Het commando ${val} naar ${what} sturen?`,
        restart: what => `De instantie ${what} herstarten?`,
        update: (what, val) => `De adapter ${what} bijwerken, ${val}?`,
        answer: 'Zeg ja of nee.',
    },
    fr: {
        write: (what, val) => `Régler ${what} sur ${val} ?`,
        sendTo: (what, val) => `Envoyer la commande ${val} à ${what} ?`,
        restart: what => `Redémarrer l'instance ${what} ?`,
        update: (what, val) => `Mettre à jour l'adaptateur ${what}, ${val} ?`,
        answer: 'Dites oui ou non.',
    },
    it: {
        write: (what, val) => `Impostare ${what} su ${val}?`,
        sendTo: (what, val) => `Inviare il comando ${val} a ${what}?`,
        restart: what => `Riavviare l'istanza ${what}?`,
        update: (what, val) => `Aggiornare l'adattatore ${what}, ${val}?`,
        answer: 'Rispondi sì o no.',
    },
    es: {
        write: (what, val) => `¿Poner ${what} en ${val}?`,
        sendTo: (what, val) => `¿Enviar el comando ${val} a ${what}?`,
        restart: what => `¿Reiniciar la instancia ${what}?`,
        update: (what, val) => `¿Actualizar el adaptador ${what}, ${val}?`,
        answer: 'Di sí o no.',
    },
    pl: {
        write: (what, val) => `Ustawić ${what} na ${val}?`,
        sendTo: (what, val) => `Wysłać polecenie ${val} do ${what}?`,
        restart: what => `Uruchomić ponownie instancję ${what}?`,
        update: (what, val) => `Zaktualizować adapter ${what}, ${val}?`,
        answer: 'Powiedz tak lub nie.',
    },
    uk: {
        write: (what, val) => `Встановити ${what} у ${val}?`,
        sendTo: (what, val) => `Надіслати команду ${val} до ${what}?`,
        restart: what => `Перезапустити інстанс ${what}?`,
        update: (what, val) => `Оновити адаптер ${what}, ${val}?`,
        answer: 'Скажи так або ні.',
    },
    'zh-cn': {
        write: (what, val) => `将 ${what} 设为 ${val}？`,
        sendTo: (what, val) => `向 ${what} 发送命令 ${val}？`,
        restart: what => `重启实例 ${what}？`,
        update: (what, val) => `更新适配器 ${what}，${val}？`,
        answer: '请说是或否。',
    },
};

/**
 * @param {unknown} language system language of ioBroker
 * @returns {string} a language of QUESTIONS, else "en"
 */
function languageOf(language) {
    const lang = String(language || '').toLowerCase();
    return Object.hasOwn(QUESTIONS, lang) ? lang : 'en';
}

/**
 * Whether the answer is "yes": what the user said is one of the yes words, apart from case, spaces and punctuation
 * around it. "Yes, but first …" is no. A caller may put context in front of the words of the user, separated by an
 * empty line (ioBroker.assistant sends time, weather and presence first), so only the last paragraph counts.
 *
 * @param {unknown} text answer of the caller
 * @returns {boolean} confirmed
 */
function isYes(text) {
    const answer = String(text ?? '')
        .trim()
        .split(/\n\s*\n/)
        .at(-1)
        .toLowerCase()
        .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
    return YES_WORDS.includes(answer);
}

/**
 * The question for the caller, followed by the marker that opens the microphone again.
 *
 * @param {unknown} language system language
 * @param {{ what: string, val?: unknown, action?: string }} request what is asked (what: name or id)
 * @returns {string} question
 */
function confirmationQuestion(language, { what, val, action }) {
    const q = QUESTIONS[languageOf(language)];
    const value = typeof val === 'string' ? val : JSON.stringify(val);
    const ask = action === 'restart' || action === 'update' || action === 'sendTo' ? q[action] : q.write;
    return `${ask(what, value)} ${q.answer} ${LISTEN}`;
}

/**
 * The confirmations that wait for the next "ask" of a sendTo conversation, and the callers that wait for an answer.
 */
class TextConfirmations {
    /**
     * @param {{ setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (handle: unknown) => void }} timers
     *     timers of the adapter
     */
    constructor(timers) {
        this.timers = timers;
        this.timeoutMs = TEXT_CONFIRMATION_TIMEOUT_MS;
        /** Per conversation: the caller that waits for an answer ({ notify, run }). */
        this.listeners = new Map();
        /** Per conversation: the confirmation that waits for the next message ({ resolve, timer, run }). */
        this.waiting = new Map();
    }

    /**
     * Answer a caller: the end of the request, or a question when the request needs a confirmation first.
     *
     * @param {string} key conversation key
     * @param {Promise<string>} run the request
     * @returns {Promise<string>} answer or question
     */
    answerOf(key, run) {
        let listener;
        const question = new Promise(resolve => {
            listener = { notify: resolve, run };
            this.listeners.set(key, listener);
        });
        const done = () => {
            if (this.listeners.get(key) === listener) {
                this.listeners.delete(key);
            }
        };
        run.then(done, done);
        return Promise.race([run, question]).finally(done);
    }

    /**
     * A confirmation is needed in a conversation: send the question to the caller that waits there.
     *
     * @param {string} key conversation key
     * @param {string} question question
     * @returns {Promise<string>} "yes", "no", "timeout", or "unavailable" when no caller waits
     */
    request(key, question) {
        const listener = this.listeners.get(key);
        if (!listener || this.waiting.has(key)) {
            return Promise.resolve('unavailable');
        }
        this.listeners.delete(key);
        return new Promise(resolve => {
            const timer = this.timers.setTimeout(() => {
                this.waiting.delete(key);
                resolve('timeout');
            }, this.timeoutMs);
            this.waiting.set(key, { resolve, timer, run: listener.run });
            listener.notify(question);
        });
    }

    /**
     * @param {string} key conversation key
     * @returns {boolean} a confirmation waits for the next message of this conversation
     */
    has(key) {
        return this.waiting.has(key);
    }

    /**
     * The next message of the caller decides the waiting confirmation.
     *
     * @param {string} key conversation key
     * @param {boolean} yes the message is a yes word
     * @returns {Promise<string>} the request that asked; its answer goes to this caller
     */
    decide(key, yes) {
        const entry = this.waiting.get(key);
        if (!entry) {
            throw new Error('No confirmation waits');
        }
        this.waiting.delete(key);
        this.timers.clearTimeout(entry.timer);
        entry.resolve(yes ? 'yes' : 'no');
        return entry.run;
    }

    /** On unload: the waiting confirmations are not done. */
    stop() {
        for (const [key, entry] of this.waiting) {
            this.timers.clearTimeout(entry.timer);
            entry.resolve('timeout');
            this.waiting.delete(key);
        }
    }
}

module.exports = { TextConfirmations, isYes, confirmationQuestion, TEXT_CONFIRMATION_TIMEOUT_MS, LISTEN };
