'use strict';

/** Telegram allows 4096 characters per message; leave room for nothing else. */
const MAX_MESSAGE = 4000;

/**
 * Normalize a user name for comparison: no leading "@", lower case.
 *
 * @param {unknown} name user name or id
 * @returns {string} normalized token
 */
function normalizeUser(name) {
    return String(name ?? '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
}

/**
 * Allowed Telegram users from the configuration: user ids or user names, one per line or separated by commas
 * (a table cell has only one line); "#" starts a comment.
 *
 * @param {string} text raw configuration text
 * @returns {Set<string>} normalized ids and names
 */
function parseAllowedUsers(text) {
    const result = new Set();
    for (const raw of String(text || '').split(/[\r\n,;]+/)) {
        const line = normalizeUser(raw);
        if (line && !line.startsWith('#')) {
            result.add(line);
        }
    }
    return result;
}

/**
 * Whether a sender may talk to the agent. An empty list allows nobody.
 *
 * The first name ("Alex") is what the telegram adapter and other adapters use, but anybody can choose any
 * first name in Telegram. It therefore counts only for a sender the telegram adapter already knows
 * (listed in <telegram>.communicate.users, i.e. authenticated there); id and user name always count.
 *
 * @param {{ userId?: unknown, userName?: unknown, firstName?: unknown, known?: boolean }} sender sender of the message
 * @param {Set<string>} allowed result of parseAllowedUsers
 * @returns {boolean} true when the id, the user name or (for a known sender) the first name is on the list
 */
function isAllowedUser(sender, allowed) {
    const has = value => {
        const token = normalizeUser(value);
        return token !== '' && allowed.has(token);
    };
    return has(sender.userId) || has(sender.userName) || (sender.known === true && has(sender.firstName));
}

/**
 * Split the value of <telegram>.communicate.request ("[name]text") into name and text.
 *
 * @param {unknown} value state value
 * @returns {{ name: string, text: string }} sender name as the telegram adapter wrote it, and the text
 */
function parseRequest(value) {
    const match = /^\[([^\]]*)\]([\s\S]*)$/.exec(String(value ?? ''));
    return match ? { name: match[1], text: match[2].trim() } : { name: '', text: String(value ?? '').trim() };
}

/**
 * Text for the agent when the message passes the prefix rule, otherwise null.
 *
 * @param {string} text message text
 * @param {string} prefix configured prefix; empty means every message
 * @returns {string | null} text without the prefix, or null when the message is not for the agent
 */
function stripPrefix(text, prefix) {
    const p = String(prefix || '').trim();
    if (!p) {
        return text || null;
    }
    if (!text.toLowerCase().startsWith(p.toLowerCase())) {
        return null;
    }
    const after = text.slice(p.length);
    // "pi" must not catch "pizza": the prefix ends at a space, a punctuation mark or the end of the text
    if (/^[\p{L}\p{N}_]/u.test(after)) {
        return null;
    }
    const rest = after.replace(/^[\s:,.;!?-]+/, '').trim();
    return rest || null;
}

/**
 * Stable request id of one Telegram message, so a message delivered twice is answered once.
 *
 * @param {string} instance telegram instance: the same chat and message id exist on every bot
 * @param {unknown} chatId chat of the message
 * @param {unknown} messageId Telegram message id
 * @returns {string} request id
 */
function telegramRequestId(instance, chatId, messageId) {
    return `tg-${instance}-${chatId}-${messageId}`;
}

/**
 * Split a long answer into Telegram-sized parts, preferring line breaks.
 *
 * @param {string} text answer
 * @param {number} [max] maximum part length
 * @returns {string[]} parts, at least one
 */
function splitMessage(text, max = MAX_MESSAGE) {
    const parts = [];
    let rest = String(text || '');
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut < max / 2) {
            cut = max;
        }
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    parts.push(rest);
    return parts;
}

/** Instructions for conversations that are Telegram chats. */
const TELEGRAM_INSTRUCTIONS =
    'This conversation is a Telegram chat. Keep answers short. Use only simple formatting (bold, italic, inline code, short lists); avoid tables and headings. A message that starts with 🎤 is a voice message turned into text by speech recognition: it can contain misheard words, so go by what was most likely meant.';

/**
 * Escape text for Telegram's HTML parse mode.
 *
 * @param {string} text plain text
 * @returns {string} text with &, < and > escaped
 */
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert the Markdown a model writes into the small HTML subset Telegram understands (parse_mode "HTML").
 * Everything else is escaped, so a stray "<" in an answer can never break the message.
 *
 * @param {string} markdown answer of the model
 * @returns {string} Telegram HTML
 */
function markdownToTelegramHtml(markdown) {
    const kept = [];
    // placeholders use a private-use character that does not occur in an answer
    const keep = html => `${kept.push(html) - 1}`;
    let text = String(markdown || '');
    // fenced code blocks and tables keep their layout in a monospace block
    text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) =>
        keep(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`),
    );
    text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+/gm, table => {
        const rows = table
            .trimEnd()
            .split('\n')
            .map(row => row.trim())
            .filter(row => !/^\|[\s:|-]+\|$/.test(row));
        return `${keep(`<pre>${escapeHtml(rows.join('\n'))}</pre>`)}\n`;
    });
    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
    text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');
    text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
    text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1<i>$2</i>');
    text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
    text = text.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, url) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
    );
    return text.replace(/(\d+)/g, (_, i) => kept[Number(i)]);
}

/**
 * Whether the tags of a Telegram HTML text are closed in the right order. Telegram rejects a message with
 * broken tags, and the telegram adapter does not report that back to the sender, so such a text is sent
 * as plain text instead.
 *
 * @param {string} html result of markdownToTelegramHtml
 * @returns {boolean} true when every tag is closed and nested correctly
 */
function isWellFormedHtml(html) {
    const stack = [];
    for (const [, closing, name] of html.matchAll(/<(\/?)(b|i|s|code|pre|a)\b[^>]*>/g)) {
        if (!closing) {
            stack.push(name);
        } else if (stack.pop() !== name) {
            return false;
        }
    }
    return stack.length === 0;
}

module.exports = {
    TELEGRAM_INSTRUCTIONS,
    escapeHtml,
    isWellFormedHtml,
    markdownToTelegramHtml,
    parseAllowedUsers,
    isAllowedUser,
    parseRequest,
    stripPrefix,
    telegramRequestId,
    splitMessage,
    MAX_MESSAGE,
};
