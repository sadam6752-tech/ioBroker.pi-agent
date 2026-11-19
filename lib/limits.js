'use strict';

// Limits against runaway requests, checked before the model is asked: a loop (a script or another adapter that asks
// again right after every answer) hits the requests per minute of its conversation, and the tokens per day cap
// whatever else runs away. Both refuse the request with an error instead of asking the model.

const WINDOW_MS = 60_000;

/** Shares of the daily limit (percent) at which the user is warned, once a day each. */
const WARN_AT = [80, 90, 99];

/**
 * Calendar day of an instant in a time zone, e.g. "2026-11-03".
 *
 * @param {number} ts instant (ms)
 * @param {string} zone IANA time zone
 * @returns {string} day
 */
function localDay(ts, zone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(ts));
}

/**
 * @param {string} day calendar day
 * @param {number} tokens tokens counted for it
 * @param {number | null} lastTotal tokens of all conversations at the last count, null before the first
 * @returns {{ day: string, tokens: number, lastTotal: number | null }} count of the day
 */
function dayCount(day, tokens, lastTotal) {
    return { day, tokens, lastTotal };
}

/**
 * @param {object} options limits from the settings
 * @param {number} options.perMinute requests per minute and conversation, 0 = no limit
 * @param {number} options.dailyTokens tokens per day, 0 = no limit
 * @param {string} options.timeZone time zone of the house; the day starts at its midnight
 * @param {{ warn: (msg: string) => void }} options.log logger
 * @param {() => number} [options.now] clock, replaceable in tests
 * @returns {object} limits
 */
function createLimits({ perMinute, dailyTokens, timeZone, log, now = Date.now }) {
    // start times of the requests of the last minute, per conversation
    const recent = new Map();
    /** conversations warned about in their current run of refusals */
    const warned = new Set();
    // tokens of the day; lastTotal is the sum of all conversations when they were last counted
    let today = dayCount(localDay(now(), timeZone), 0, null);
    let warnedDay = '';
    // highest share of the limit already reported today, and the one reached since the last takeWarning()
    let reportedLevel = 0;
    let newLevel = 0;

    /** @returns {number} highest share of WARN_AT the tokens of today reached, 0 = none */
    const levelOf = () => (dailyTokens > 0 ? WARN_AT.filter(p => today.tokens * 100 >= p * dailyTokens).pop() || 0 : 0);

    const reached = () => dailyTokens > 0 && today.day === localDay(now(), timeZone) && today.tokens >= dailyTokens;

    return {
        /**
         * Refuse a request over a limit.
         *
         * @param {string} key conversation, e.g. "sendTo:assistant.0/chat"
         * @throws {Error} when the request may not be asked
         */
        admit(key) {
            if (reached()) {
                throw new Error(
                    `The daily token limit (${dailyTokens}) is reached; the agent answers again after midnight`,
                );
            }
            if (!(perMinute > 0)) {
                return;
            }
            const t = now();
            const list = (recent.get(key) || []).filter(start => t - start < WINDOW_MS);
            if (list.length === 0) {
                warned.delete(key);
            }
            if (list.length >= perMinute) {
                recent.set(key, list);
                if (!warned.has(key)) {
                    warned.add(key);
                    log.warn(
                        `${key}: more than ${perMinute} requests per minute, further requests are refused. A script or an adapter that asks again after every answer?`,
                    );
                }
                throw new Error(`Too many requests from this conversation (at most ${perMinute} per minute)`);
            }
            list.push(t);
            recent.set(key, list);
            for (const [other, starts] of recent) {
                if (other !== key && starts.every(start => t - start >= WINDOW_MS)) {
                    recent.delete(other);
                }
            }
        },

        /**
         * Take the tokens of all conversations together; what they grew by counts for today. A total that shrank
         * (old conversations deleted) counts nothing.
         *
         * @param {number} total tokens of all conversations
         * @returns {{ tokens: number, reached: boolean }} tokens of today and whether the daily limit is reached
         */
        count(total) {
            const day = localDay(now(), timeZone);
            if (today.day !== day) {
                today = dayCount(day, 0, today.lastTotal);
                reportedLevel = 0;
                newLevel = 0;
            }
            if (today.lastTotal !== null && total > today.lastTotal) {
                today.tokens += total - today.lastTotal;
            }
            today.lastTotal = total;
            const level = levelOf();
            if (level > reportedLevel) {
                reportedLevel = level;
                newLevel = level;
            }
            const isReached = reached();
            if (isReached && warnedDay !== day) {
                warnedDay = day;
                log.warn(
                    `The daily token limit (${dailyTokens}) is reached with ${today.tokens} tokens; requests are refused until midnight`,
                );
            }
            return { tokens: today.tokens, reached: isReached };
        },

        /**
         * Continue the count of the last run.
         *
         * @param {number} tokens tokens of the day as stored (usage.tokensToday)
         * @param {number} storedAt when they were stored (ms)
         * @param {number | null} lastTotal tokens of all conversations then (usage.tokensTotal)
         */
        restore(tokens, storedAt, lastTotal) {
            const sameDay = localDay(storedAt, timeZone) === localDay(now(), timeZone);
            today = dayCount(localDay(now(), timeZone), sameDay ? Number(tokens) || 0 : 0, lastTotal);
            // what was reached before the restart was reported then
            reportedLevel = levelOf();
            newLevel = 0;
        },

        /**
         * The warning about the share of the daily limit that the last counts reached, once a day per share.
         *
         * @returns {string} text for the user, "" when there is nothing new
         */
        takeWarning() {
            const level = newLevel;
            newLevel = 0;
            if (!level || reached()) {
                return '';
            }
            return `⚠️ ${level} % of the daily token limit is used (${today.tokens} of ${dailyTokens} tokens). At 100 % the agent stops answering until midnight.`;
        },

        /** @returns {boolean} whether the daily limit is reached now */
        reached,
    };
}

module.exports = { createLimits, localDay, WINDOW_MS, WARN_AT };
