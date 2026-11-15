'use strict';

/**
 * Size of the context of a request: how many tokens of a conversation go to the model with every request.
 *
 * Every request carries the instructions, the tool descriptions and the history of the conversation. Without a
 * limit the harness lets the history grow up to the context window of the model (minus room for the answer) and only
 * then summarises it - with a window of 128k tokens that is up to about 100k tokens per request. A provider cache
 * makes repeated tokens cheap, but the first request after a pause (the cache is gone) pays all of them, and every
 * request pays for the cached ones as well.
 *
 * With a limit, the older part of the history is summarised as soon as the context reaches it: in the background
 * from three quarters of the limit on, blocking at the limit. The summary keeps the most recent part (30 % of the
 * limit) verbatim. The fixed part (instructions and tools, about 5-10k tokens) counts against the limit as well,
 * which is why the limit has a lower bound.
 */

/** Smallest limit: below it, the fixed part and the kept history would start a summary at every request. */
const MIN_CONTEXT_TOKENS = 24000;

/** Room the harness keeps free for the answer by default (DEFAULT_COMPACTION_POLICY of pi-durable). */
const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * The limit of the settings: 0 (or empty) means no limit, anything else at least MIN_CONTEXT_TOKENS.
 *
 * @param {unknown} value value of the setting
 * @returns {number} the limit in tokens, 0 for none
 */
function contextLimitOf(value) {
    const limit = Math.floor(Number(value));
    if (!Number.isFinite(limit) || limit <= 0) {
        return 0;
    }
    return Math.max(MIN_CONTEXT_TOKENS, limit);
}

/**
 * The compaction policy of pi-durable for one model that keeps its context below the limit.
 *
 * @param {number} limit limit in tokens (contextLimitOf), 0 for none
 * @param {number} contextWindow context window of the model in tokens
 * @returns {{ reserveTokens: number, keepRecentTokens: number, backgroundTokens: number } | null} policy, null when the default of the harness applies
 */
function compactionPolicyFor(limit, contextWindow) {
    if (!(limit > 0) || !(contextWindow > 0)) {
        return null;
    }
    // the harness compacts blocking above contextWindow - reserveTokens
    const reserveTokens = contextWindow - limit;
    if (reserveTokens <= DEFAULT_RESERVE_TOKENS) {
        // the limit is as large as the window allows anyway
        return null;
    }
    return {
        reserveTokens,
        keepRecentTokens: Math.round(limit * 0.3),
        backgroundTokens: Math.round(limit * 0.25),
    };
}

/**
 * A line for the debug log with the token use of one model call.
 *
 * @param {string} model "provider/model"
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, cost?: { total?: number } } | undefined} usage usage of the answer (pi-ai)
 * @returns {string} the line
 */
function usageLine(model, usage) {
    const input = Number(usage?.input) || 0;
    const cached = Number(usage?.cacheRead) || 0;
    const written = Number(usage?.cacheWrite) || 0;
    const output = Number(usage?.output) || 0;
    const context = input + cached + written;
    const share = context > 0 ? Math.round((cached / context) * 100) : 0;
    const cost = Number(usage?.cost?.total) || 0;
    const parts = [
        `context ${context} tokens (${cached} from the cache = ${share} %, ${input} new${written ? `, ${written} written to the cache` : ''})`,
        `answer ${output}`,
        `cost $${cost.toFixed(5)}`,
    ];
    return `Model call ${model}: ${parts.join(', ')}`;
}

module.exports = { MIN_CONTEXT_TOKENS, contextLimitOf, compactionPolicyFor, usageLine };
