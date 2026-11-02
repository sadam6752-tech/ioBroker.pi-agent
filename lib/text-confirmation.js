'use strict';

// Confirmation by text in sendTo conversations (e.g. ioBroker.assistant): the caller cannot show buttons, so the
// question goes back as the answer of its "ask", and its next "ask" in the same conversation decides. Only a plain
// "yes" word confirms; the decision never goes through the model.

const { WARNING } = require('./scripts');

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
        scriptNew: what => `Save the new script ${what}?`,
        scriptChange: what => `Save the change of the script ${what}?`,
        scriptRunning: 'It is running and restarts at once.',
        scriptWarnings: list => `Caution, the code uses: ${list}.`,
        scriptStart: what => `Start the script ${what}?`,
        scriptStop: what => `Stop the script ${what}?`,
        scriptRevert: what => `Bring back the previous version of the script ${what}? It is stopped afterwards.`,
        answer: 'Say yes or no.',
    },
    de: {
        write: (what, val) => `${what} auf ${val} setzen?`,
        sendTo: (what, val) => `Den Befehl ${val} an ${what} senden?`,
        restart: what => `Die Instanz ${what} neu starten?`,
        update: (what, val) => `Den Adapter ${what} aktualisieren, ${val}?`,
        scriptNew: what => `Das neue Skript ${what} speichern?`,
        scriptChange: what => `Die Änderung am Skript ${what} speichern?`,
        scriptRunning: 'Es läuft und startet sofort neu.',
        scriptWarnings: list => `Achtung, der Code nutzt: ${list}.`,
        scriptStart: what => `Das Skript ${what} starten?`,
        scriptStop: what => `Das Skript ${what} stoppen?`,
        scriptRevert: what => `Die vorige Version des Skripts ${what} zurückholen? Danach ist es gestoppt.`,
        answer: 'Sag ja oder nein.',
    },
    ru: {
        write: (what, val) => `Установить ${what} в ${val}?`,
        sendTo: (what, val) => `Отправить команду ${val} в ${what}?`,
        restart: what => `Перезапустить инстанс ${what}?`,
        update: (what, val) => `Обновить адаптер ${what}, ${val}?`,
        scriptNew: what => `Сохранить новый скрипт ${what}?`,
        scriptChange: what => `Сохранить изменения скрипта ${what}?`,
        scriptRunning: 'Он сейчас работает и сразу перезапустится.',
        scriptWarnings: list => `Внимание, в коде: ${list}.`,
        scriptStart: what => `Запустить скрипт ${what}?`,
        scriptStop: what => `Остановить скрипт ${what}?`,
        scriptRevert: what => `Вернуть прошлую версию скрипта ${what}? После этого он будет выключен.`,
        answer: 'Скажи да или нет.',
    },
    pt: {
        write: (what, val) => `Definir ${what} como ${val}?`,
        sendTo: (what, val) => `Enviar o comando ${val} para ${what}?`,
        restart: what => `Reiniciar a instância ${what}?`,
        update: (what, val) => `Atualizar o adaptador ${what}, ${val}?`,
        scriptNew: what => `Guardar o novo script ${what}?`,
        scriptChange: what => `Guardar a alteração do script ${what}?`,
        scriptRunning: 'Está a correr e reinicia de imediato.',
        scriptWarnings: list => `Atenção, o código usa: ${list}.`,
        scriptStart: what => `Iniciar o script ${what}?`,
        scriptStop: what => `Parar o script ${what}?`,
        scriptRevert: what => `Repor a versão anterior do script ${what}? Depois fica parado.`,
        answer: 'Diga sim ou não.',
    },
    nl: {
        write: (what, val) => `${what} op ${val} zetten?`,
        sendTo: (what, val) => `Het commando ${val} naar ${what} sturen?`,
        restart: what => `De instantie ${what} herstarten?`,
        update: (what, val) => `De adapter ${what} bijwerken, ${val}?`,
        scriptNew: what => `Het nieuwe script ${what} opslaan?`,
        scriptChange: what => `De wijziging van het script ${what} opslaan?`,
        scriptRunning: 'Het draait en herstart meteen.',
        scriptWarnings: list => `Let op, de code gebruikt: ${list}.`,
        scriptStart: what => `Het script ${what} starten?`,
        scriptStop: what => `Het script ${what} stoppen?`,
        scriptRevert: what => `De vorige versie van het script ${what} terugzetten? Daarna is het gestopt.`,
        answer: 'Zeg ja of nee.',
    },
    fr: {
        write: (what, val) => `Régler ${what} sur ${val} ?`,
        sendTo: (what, val) => `Envoyer la commande ${val} à ${what} ?`,
        restart: what => `Redémarrer l'instance ${what} ?`,
        update: (what, val) => `Mettre à jour l'adaptateur ${what}, ${val} ?`,
        scriptNew: what => `Enregistrer le nouveau script ${what} ?`,
        scriptChange: what => `Enregistrer la modification du script ${what} ?`,
        scriptRunning: 'Il tourne et redémarre aussitôt.',
        scriptWarnings: list => `Attention, le code utilise : ${list}.`,
        scriptStart: what => `Démarrer le script ${what} ?`,
        scriptStop: what => `Arrêter le script ${what} ?`,
        scriptRevert: what => `Rétablir la version précédente du script ${what} ? Il sera ensuite arrêté.`,
        answer: 'Dites oui ou non.',
    },
    it: {
        write: (what, val) => `Impostare ${what} su ${val}?`,
        sendTo: (what, val) => `Inviare il comando ${val} a ${what}?`,
        restart: what => `Riavviare l'istanza ${what}?`,
        update: (what, val) => `Aggiornare l'adattatore ${what}, ${val}?`,
        scriptNew: what => `Salvare il nuovo script ${what}?`,
        scriptChange: what => `Salvare la modifica dello script ${what}?`,
        scriptRunning: 'È in esecuzione e si riavvia subito.',
        scriptWarnings: list => `Attenzione, il codice usa: ${list}.`,
        scriptStart: what => `Avviare lo script ${what}?`,
        scriptStop: what => `Fermare lo script ${what}?`,
        scriptRevert: what => `Ripristinare la versione precedente dello script ${what}? Dopo sarà fermo.`,
        answer: 'Rispondi sì o no.',
    },
    es: {
        write: (what, val) => `¿Poner ${what} en ${val}?`,
        sendTo: (what, val) => `¿Enviar el comando ${val} a ${what}?`,
        restart: what => `¿Reiniciar la instancia ${what}?`,
        update: (what, val) => `¿Actualizar el adaptador ${what}, ${val}?`,
        scriptNew: what => `¿Guardar el nuevo script ${what}?`,
        scriptChange: what => `¿Guardar el cambio del script ${what}?`,
        scriptRunning: 'Está en marcha y se reinicia enseguida.',
        scriptWarnings: list => `Atención, el código usa: ${list}.`,
        scriptStart: what => `¿Iniciar el script ${what}?`,
        scriptStop: what => `¿Detener el script ${what}?`,
        scriptRevert: what => `¿Recuperar la versión anterior del script ${what}? Después quedará detenido.`,
        answer: 'Di sí o no.',
    },
    pl: {
        write: (what, val) => `Ustawić ${what} na ${val}?`,
        sendTo: (what, val) => `Wysłać polecenie ${val} do ${what}?`,
        restart: what => `Uruchomić ponownie instancję ${what}?`,
        update: (what, val) => `Zaktualizować adapter ${what}, ${val}?`,
        scriptNew: what => `Zapisać nowy skrypt ${what}?`,
        scriptChange: what => `Zapisać zmianę skryptu ${what}?`,
        scriptRunning: 'Działa i od razu uruchomi się ponownie.',
        scriptWarnings: list => `Uwaga, kod używa: ${list}.`,
        scriptStart: what => `Uruchomić skrypt ${what}?`,
        scriptStop: what => `Zatrzymać skrypt ${what}?`,
        scriptRevert: what => `Przywrócić poprzednią wersję skryptu ${what}? Potem będzie zatrzymany.`,
        answer: 'Powiedz tak lub nie.',
    },
    uk: {
        write: (what, val) => `Встановити ${what} у ${val}?`,
        sendTo: (what, val) => `Надіслати команду ${val} до ${what}?`,
        restart: what => `Перезапустити інстанс ${what}?`,
        update: (what, val) => `Оновити адаптер ${what}, ${val}?`,
        scriptNew: what => `Зберегти новий скрипт ${what}?`,
        scriptChange: what => `Зберегти зміни скрипту ${what}?`,
        scriptRunning: 'Він зараз працює і одразу перезапуститься.',
        scriptWarnings: list => `Увага, у коді: ${list}.`,
        scriptStart: what => `Запустити скрипт ${what}?`,
        scriptStop: what => `Зупинити скрипт ${what}?`,
        scriptRevert: what => `Повернути попередню версію скрипту ${what}? Після цього він буде вимкнений.`,
        answer: 'Скажи так або ні.',
    },
    'zh-cn': {
        write: (what, val) => `将 ${what} 设为 ${val}？`,
        sendTo: (what, val) => `向 ${what} 发送命令 ${val}？`,
        restart: what => `重启实例 ${what}？`,
        update: (what, val) => `更新适配器 ${what}，${val}？`,
        scriptNew: what => `保存新脚本 ${what}？`,
        scriptChange: what => `保存脚本 ${what} 的修改？`,
        scriptRunning: '它正在运行，会立即重启。',
        scriptWarnings: list => `注意，代码使用了：${list}。`,
        scriptStart: what => `启动脚本 ${what}？`,
        scriptStop: what => `停止脚本 ${what}？`,
        scriptRevert: what => `恢复脚本 ${what} 的上一个版本？之后它将停止。`,
        answer: '请说是或否。',
    },
};

/**
 * The warnings of a script (lib/scripts.js scriptWarnings) in the language of the question; names of calls (exec,
 * require, sendTo …) stay as they are. English needs no entry.
 */
const WARNING_WORDS = {
    de: {
        [WARNING.fileAccess]: 'Dateizugriffe',
        [WARNING.objectChanges]: 'Objektänderungen',
        [WARNING.network]: 'Netzwerk',
        [WARNING.outside]: 'setState außerhalb der Schreibrechte',
        [WARNING.computedId]: 'setState mit berechneter ID',
    },
    ru: {
        [WARNING.fileAccess]: 'доступ к файлам',
        [WARNING.objectChanges]: 'изменение объектов',
        [WARNING.network]: 'сеть',
        [WARNING.outside]: 'setState вне прав на запись',
        [WARNING.computedId]: 'setState с вычисляемым ID',
    },
    pt: {
        [WARNING.fileAccess]: 'acesso a ficheiros',
        [WARNING.objectChanges]: 'alterações de objetos',
        [WARNING.network]: 'rede',
        [WARNING.outside]: 'setState fora das permissões de escrita',
        [WARNING.computedId]: 'setState com um ID calculado',
    },
    nl: {
        [WARNING.fileAccess]: 'bestandstoegang',
        [WARNING.objectChanges]: 'objectwijzigingen',
        [WARNING.network]: 'netwerk',
        [WARNING.outside]: 'setState buiten de schrijfrechten',
        [WARNING.computedId]: 'setState met een berekende ID',
    },
    fr: {
        [WARNING.fileAccess]: 'accès aux fichiers',
        [WARNING.objectChanges]: 'modifications d’objets',
        [WARNING.network]: 'réseau',
        [WARNING.outside]: 'setState hors des droits d’écriture',
        [WARNING.computedId]: 'setState avec un ID calculé',
    },
    it: {
        [WARNING.fileAccess]: 'accesso ai file',
        [WARNING.objectChanges]: 'modifiche agli oggetti',
        [WARNING.network]: 'rete',
        [WARNING.outside]: 'setState fuori dai permessi di scrittura',
        [WARNING.computedId]: 'setState con un ID calcolato',
    },
    es: {
        [WARNING.fileAccess]: 'acceso a archivos',
        [WARNING.objectChanges]: 'cambios de objetos',
        [WARNING.network]: 'red',
        [WARNING.outside]: 'setState fuera de los permisos de escritura',
        [WARNING.computedId]: 'setState con un ID calculado',
    },
    pl: {
        [WARNING.fileAccess]: 'dostęp do plików',
        [WARNING.objectChanges]: 'zmiany obiektów',
        [WARNING.network]: 'sieć',
        [WARNING.outside]: 'setState poza uprawnieniami do zapisu',
        [WARNING.computedId]: 'setState z obliczanym ID',
    },
    uk: {
        [WARNING.fileAccess]: 'доступ до файлів',
        [WARNING.objectChanges]: 'зміна об’єктів',
        [WARNING.network]: 'мережа',
        [WARNING.outside]: 'setState поза правами на запис',
        [WARNING.computedId]: 'setState з обчислюваним ID',
    },
    'zh-cn': {
        [WARNING.fileAccess]: '文件访问',
        [WARNING.objectChanges]: '对象修改',
        [WARNING.network]: '网络',
        [WARNING.outside]: '超出写入权限的 setState',
        [WARNING.computedId]: '使用计算 ID 的 setState',
    },
};

/**
 * A warning of a script in the language of the question. "setState outside the write permissions: <ids>" keeps the ids.
 *
 * @param {string} lang a language of QUESTIONS
 * @param {unknown} warning warning of scriptWarnings, in English
 * @returns {string} the warning to speak
 */
function spokenWarning(lang, warning) {
    const text = String(warning);
    const at = text.indexOf(': ');
    const label = at < 0 ? text : text.slice(0, at);
    const word = WARNING_WORDS[lang]?.[label];
    return word ? `${word}${at < 0 ? '' : text.slice(at)}` : text;
}

/**
 * @param {unknown} language language of the caller or of the system, e.g. "de", "ru-RU" or "zh-cn"
 * @returns {string} a language of QUESTIONS, else "en"
 */
function languageOf(language) {
    const lang = String(language || '').toLowerCase();
    if (Object.hasOwn(QUESTIONS, lang)) {
        return lang;
    }
    const base = lang.split(/[-_]/)[0];
    return Object.hasOwn(QUESTIONS, base) ? base : 'en';
}

/**
 * What the user said: a caller may put context in front of it, separated by an empty line (ioBroker.assistant sends
 * time, weather and presence first), so only the last paragraph counts.
 *
 * @param {unknown} text answer of the caller
 * @returns {string} the words of the user
 */
function spokenAnswer(text) {
    return String(text ?? '')
        .trim()
        .split(/\n\s*\n/)
        .at(-1)
        .trim();
}

/**
 * Whether the answer is "yes": what the user said is one of the yes words, apart from case, spaces and punctuation.
 * "Yes, but first …" is no. The same yes said twice ("да да", "Ja, ja.") is yes: speech recognition doubles short
 * words, a spoken "Да." came back as "Да да.".
 *
 * @param {unknown} text answer of the caller
 * @returns {boolean} confirmed
 */
function isYes(text) {
    const words = spokenAnswer(text)
        .toLowerCase()
        .split(/[\s\p{P}]+/u)
        .filter(Boolean);
    return words.length > 0 && words.every(word => YES_WORDS.includes(word));
}

/**
 * The question for the caller, followed by the marker that opens the microphone again.
 *
 * @param {unknown} language language of the caller (ask "language"), else the system language
 * @param {{ what: string, val?: unknown, action?: string }} request what is asked (what: name or id)
 * @returns {string} question
 */
function confirmationQuestion(language, { what, val, action }) {
    const lang = languageOf(language);
    const q = QUESTIONS[lang];
    if (String(action).startsWith('script')) {
        // the code cannot be read out: what it does (in the words of the model), and what pi-agent found in it
        const v = Object(val);
        const parts =
            action === 'scriptEnable'
                ? [v.enabled ? q.scriptStart(what) : q.scriptStop(what)]
                : action === 'scriptRevert'
                  ? [q.scriptRevert(what)]
                  : [v.isNew ? q.scriptNew(what) : q.scriptChange(what), String(v.summary || '').trim()];
        if (v.running && action === 'scriptSave') {
            parts.push(q.scriptRunning);
        }
        if (Array.isArray(v.warnings) && v.warnings.length) {
            parts.push(q.scriptWarnings(v.warnings.map(w => spokenWarning(lang, w)).join(', ')));
        }
        return `${parts.filter(Boolean).join(' ')} ${q.answer} ${LISTEN}`;
    }
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

module.exports = {
    TextConfirmations,
    isYes,
    spokenAnswer,
    languageOf,
    confirmationQuestion,
    TEXT_CONFIRMATION_TIMEOUT_MS,
    LISTEN,
};
