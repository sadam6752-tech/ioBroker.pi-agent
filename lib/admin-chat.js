'use strict';

const crypto = require('node:crypto');
const { markdownToTelegramHtml, isWellFormedHtml, escapeHtml } = require('./telegram');
const { withoutPictureNotes } = require('./pictures');
const { takeLanguage } = require('./answer-language');

/** Pseudo instance of the admin chat in the keys of telegram.chats: "admin/<user>". */
const ADMIN = 'admin';

/** How long a confirmation in the admin chat waits for a button. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;

/** At most this many entries of a conversation go to the admin page. */
const MAX_HISTORY = 200;

const ADMIN_INSTRUCTIONS =
    'This conversation is the chat in the ioBroker admin. Markdown is shown formatted: bold, italic, inline code, code blocks, lists and links; tables are shown as monospace text.';

/**
 * Markdown of the model as safe HTML for the admin page (the same subset as Telegram: b, i, code, pre, a).
 *
 * @param {string} text Markdown
 * @returns {string} HTML
 */
/**
 * Text of a model answer as the user sees it: without picture notes and language marks.
 *
 * @param {string | undefined} text answer of the model
 * @returns {string} text, '' when nothing is left
 */
function shown(text) {
    return takeLanguage(withoutPictureNotes(text || '')).text;
}

function toHtml(text) {
    const html = markdownToTelegramHtml(text);
    return isWellFormedHtml(html) ? html : escapeHtml(text);
}

/**
 * Short text of a tool call, e.g. 'get_state x.0.lamp'.
 *
 * @param {{ name: string, arguments?: Record<string, unknown> }} call tool call
 * @returns {string} text
 */
function toolText(call) {
    const args = Object.values(call.arguments || {})
        .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ');
    return `${call.name}${args ? ` ${args}` : ''}`.slice(0, 200);
}

/** Longest arguments and result of a tool call in the details of the admin page. */
const MAX_DETAIL = 300;

/**
 * Text of a value for the details, cut to MAX_DETAIL characters.
 *
 * @param {unknown} value arguments or result
 * @returns {string} text
 */
function detailText(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

/**
 * Text of a user message with pictures (ioBroker.assistant passes on the photos of Telegram): a mark for the pictures
 * and the text.
 *
 * @param {unknown} content content blocks of the message
 * @returns {string} text
 */
function userText(content) {
    if (!Array.isArray(content)) {
        return '';
    }
    const images = content.filter(b => b?.type === 'image').length;
    const text = content
        .filter(b => b?.type === 'text')
        .map(b => b.text)
        .join('\n');
    return [images ? `[${images > 1 ? `${images} pictures` : 'picture'}]` : '', text].filter(Boolean).join(' ');
}

/**
 * Entries of a conversation as the admin page shows them.
 *
 * Besides the text, every tool call carries its details (arguments, start of the result, time, error) and the last
 * answer of a request the summary of the request (provider, model, tokens, model calls, time); the page shows them
 * when the user switches the details on.
 *
 * @param {ReadonlyArray<{ kind: string, model?: ReadonlyArray<{ role?: string, content?: unknown, timestamp?: number, provider?: string, model?: string, usage?: { input?: number, output?: number, cacheRead?: number }, toolCallId?: string, isError?: boolean, durationMs?: number }> }>} entries active entries of the conversation (Conversation.context())
 * @returns {Array<{ role: string, text?: string, html?: string, ts?: number, detail?: object, summary?: object }>} messages, oldest first
 */
function historyOf(entries) {
    const messages = [];
    /** tool call id -> its message, to add the result */
    const calls = new Map();
    /** the request being read: from its question to the next one */
    let turn = null;
    const close = () => {
        if (turn?.answer) {
            const end = Math.max(...turn.times);
            turn.answer.summary = {
                provider: turn.provider,
                model: turn.model,
                input: turn.input,
                output: turn.output,
                cached: turn.cached,
                calls: turn.calls,
                // the time of a model answer may come from the provider; only a plausible span is shown
                ms: end > turn.start && end - turn.start < 3_600_000 ? end - turn.start : undefined,
            };
        }
    };
    for (const entry of entries) {
        for (const m of entry.model || []) {
            if (entry.kind === 'pi.user' && m.role === 'user') {
                close();
                const text = typeof m.content === 'string' ? m.content : userText(m.content);
                messages.push({ role: 'user', text, ts: m.timestamp });
                turn = {
                    start: Number(m.timestamp) || 0,
                    times: [0],
                    provider: '',
                    model: '',
                    input: 0,
                    output: 0,
                    cached: 0,
                    calls: 0,
                    answer: null,
                };
            } else if (entry.kind === 'pi.assistant' && m.role === 'assistant' && Array.isArray(m.content)) {
                if (turn) {
                    turn.provider = m.provider;
                    turn.model = m.model;
                    turn.input += Number(m.usage?.input) || 0;
                    turn.output += Number(m.usage?.output) || 0;
                    turn.cached += Number(m.usage?.cacheRead) || 0;
                    turn.calls += 1;
                    turn.times.push(Number(m.timestamp) || 0);
                }
                for (const part of m.content) {
                    if (part.type === 'toolCall') {
                        const message = {
                            role: 'tool',
                            text: toolText(part),
                            ts: m.timestamp,
                            detail: { name: part.name, args: detailText(part.arguments || {}) },
                        };
                        calls.set(part.id, message);
                        messages.push(message);
                    } else if (part.type === 'text' && shown(part.text)) {
                        const message = {
                            role: 'assistant',
                            html: toHtml(shown(part.text)),
                            ts: m.timestamp,
                        };
                        messages.push(message);
                        if (turn) {
                            turn.answer = message;
                        }
                    }
                }
            } else if (entry.kind === 'pi.tool-result' && m.role === 'toolResult') {
                const call = calls.get(m.toolCallId);
                if (call) {
                    const text = (Array.isArray(m.content) ? m.content : [])
                        .filter(p => p.type === 'text')
                        .map(p => p.text)
                        .join('\n');
                    Object.assign(call.detail, {
                        result: detailText(text),
                        ms: Number.isFinite(m.durationMs) ? m.durationMs : undefined,
                        error: m.isError === true,
                    });
                }
                if (turn) {
                    turn.times.push(Number(m.timestamp) || 0);
                }
            }
        }
    }
    close();
    return messages.slice(-MAX_HISTORY);
}

/**
 * Reminders between the messages of the conversation: before the first question that was asked after them.
 * (Only the time of a user question is the local clock; the time of an answer may come from the provider.)
 *
 * @param {Array<{ role: string, ts?: number }>} entries messages in conversation order
 * @param {Array<{ role: string, ts: number }>} notices reminders, oldest first
 * @returns {Array<object>} messages and reminders
 */
function withNotices(entries, notices) {
    const result = [];
    let next = 0;
    for (const entry of entries) {
        while (entry.role === 'user' && next < notices.length && notices[next].ts < (entry.ts || 0)) {
            result.push(notices[next++]);
        }
        result.push(entry);
    }
    return [...result, ...notices.slice(next)];
}

/**
 * Questions and errors of the admin chat, per ioBroker user.
 *
 * @param {Pick<ioBroker.Adapter, 'setTimeout' | 'clearTimeout'>} adapter timers of the adapter (cleared when the instance stops)
 * @returns {object} admin chat state
 */
function createAdminChat(adapter) {
    /** user -> open confirmation */
    const questions = new Map();
    /** user -> error of the last request */
    const errors = new Map();
    /** user -> reminders that came due (kept in memory, the newest 20) */
    const notices = new Map();

    return {
        /**
         * Ask the user of the admin chat whether a write may happen; the page shows the question with buttons.
         *
         * @param {string} user ioBroker user of the conversation
         * @param {string} id state to write, or instance to restart
         * @param {unknown} val value to write
         * @param {string} [action] "restart" for the restart of an instance, else a write
         * @returns {Promise<string>} "yes", "no" or "timeout"
         */
        confirm(user, id, val, action) {
            questions.get(user)?.resolve('no'); // an older question is answered by the newer one
            const nonce = crypto.randomBytes(4).toString('hex');
            return new Promise(resolve => {
                // a timer of the adapter: js-controller clears it when the instance stops
                const timer = adapter.setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
                const finish = answer => {
                    adapter.clearTimeout(timer);
                    if (questions.get(user)?.nonce === nonce) {
                        questions.delete(user);
                    }
                    resolve(answer);
                };
                questions.set(user, { nonce, id, val, action: action || 'write', resolve: finish });
            });
        },

        /**
         * A button of the page was pressed.
         *
         * @param {string} user ioBroker user
         * @param {unknown} nonce nonce of the question
         * @param {unknown} answer "yes" or anything else
         * @returns {boolean} true when the question was still open
         */
        answer(user, nonce, answer) {
            const question = questions.get(user);
            if (!question || question.nonce !== nonce) {
                return false;
            }
            question.resolve(answer === 'yes' ? 'yes' : 'no');
            return true;
        },

        /**
         * @param {string} user ioBroker user
         * @returns {{ nonce: string, id: string, val: unknown, action: string } | null} open question
         */
        question(user) {
            const q = questions.get(user);
            return q ? { nonce: q.nonce, id: q.id, val: q.val, action: q.action } : null;
        },

        /**
         * @param {string} user ioBroker user
         * @param {string | null} text error of the last request, null to clear
         */
        setError(user, text) {
            if (text === null) {
                errors.delete(user);
            } else {
                errors.set(user, text);
            }
        },

        /**
         * @param {string} user ioBroker user
         * @returns {string | null} error of the last request
         */
        error(user) {
            return errors.get(user) ?? null;
        },

        /**
         * A reminder of the user's conversation came due: the page shows it between the messages.
         *
         * @param {string} user ioBroker user
         * @param {string} text reminder text (Markdown)
         */
        addNotice(user, text) {
            const list = [...(notices.get(user) || []), { role: 'notice', html: toHtml(text), ts: Date.now() }];
            notices.set(user, list.slice(-20));
        },

        /**
         * @param {string} user ioBroker user
         * @returns {Array<{ role: string, html: string, ts: number }>} reminders that came due
         */
        notices(user) {
            return notices.get(user) || [];
        },

        /** @param {string} user ioBroker user whose conversation starts anew */
        clear(user) {
            errors.delete(user);
            notices.delete(user);
        },
    };
}

module.exports = { ADMIN, ADMIN_INSTRUCTIONS, historyOf, toolText, userText, withNotices, createAdminChat };
