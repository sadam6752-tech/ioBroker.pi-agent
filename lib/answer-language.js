'use strict';

/**
 * The language of an answer for a caller that speaks it (ioBroker.assistant): the model marks its answer with
 * `[[lang:ru]]`, pi-agent removes the mark and returns the code as `language`, so the caller picks a voice of that
 * language. A German voice cannot read a Russian answer; it spells the Cyrillic letters.
 */

/** Rule added to the instructions of a sendTo conversation whose caller sends `language`. */
const LANGUAGE_RULE =
    'End every answer with the ISO 639-1 code of the language you answered in, as [[lang:xx]] (for example ' +
    '[[lang:de]] or [[lang:ru]]). The mark is removed before the user sees or hears the answer.';

/**
 * Reminder after each question of such a caller: a model follows a line in the question far more reliably than a rule
 * in the instructions, above all when the earlier answers of the conversation have no mark.
 */
const LANGUAGE_REMINDER = '(End your answer with [[lang:xx]], the ISO 639-1 code of the language you answer in.)';

/** Letters only Ukrainian has among the Cyrillic languages. */
const UKRAINIAN = /[ґєії]/i;

/** The mark anywhere in the text, with some tolerance for how a model writes it. */
const TAG = /\[\[\s*lang\s*[:=]\s*([a-z]{2,3}(?:-[a-z]{2,4})?)\s*\]\]/gi;

/**
 * @param {string} instructions instructions the caller sent, '' for none
 * @returns {string} the instructions with the rule after them
 */
function withLanguageRule(instructions) {
    return instructions ? `${instructions}\n\n${LANGUAGE_RULE}` : LANGUAGE_RULE;
}

/**
 * The language a text is written in as far as its letters tell: Cyrillic (Ukrainian by its own letters) and Chinese;
 * '' for Latin letters, which do not tell German from English.
 *
 * @param {string} text answer
 * @returns {string} 'ru', 'uk', 'zh' or ''
 */
function scriptLanguage(text) {
    const count = re => (String(text).match(re) || []).length;
    const cyrillic = count(/[\u0400-\u04ff]/g);
    const latin = count(/[a-z\u00c0-\u024f]/gi);
    const cjk = count(/[\u3040-\u30ff\u3400-\u9fff]/g);
    if (cjk > latin && cjk > cyrillic) {
        return 'zh';
    }
    if (cyrillic > latin) {
        return UKRAINIAN.test(text) ? 'uk' : 'ru';
    }
    return '';
}

/**
 * The question of a caller that speaks the answers, with the reminder to mark the language.
 *
 * @param {string | Array<{ type: string, text?: string }>} content text, or text and image blocks
 * @returns {string | Array<{ type: string, text?: string }>} the same with the reminder after the text
 */
function withLanguageReminder(content) {
    if (typeof content === 'string') {
        return content ? `${content}\n\n${LANGUAGE_REMINDER}` : LANGUAGE_REMINDER;
    }
    return [...content, { type: 'text', text: LANGUAGE_REMINDER }];
}

/**
 * Removes the language marks of an answer.
 *
 * @param {string} text answer of the model
 * @returns {{ text: string, language: string }} the answer without marks, and the code of the last mark ('' = none)
 */
function takeLanguage(text) {
    let language = '';
    const clean = String(text ?? '').replace(TAG, (all, code) => {
        language = String(code).toLowerCase();
        return '';
    });
    if (!language) {
        return { text: String(text ?? ''), language };
    }
    return {
        text: clean
            .replace(/[ \t]+\n/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim(),
        language,
    };
}

module.exports = {
    LANGUAGE_RULE,
    LANGUAGE_REMINDER,
    withLanguageRule,
    withLanguageReminder,
    takeLanguage,
    scriptLanguage,
};
