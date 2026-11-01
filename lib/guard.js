'use strict';

/**
 * Compile the write allowlist (one regular expression per line, "#" starts a comment).
 * Invalid lines are reported through `onInvalid` and skipped, so a typo never opens the list.
 *
 * @param {string} text raw configuration text
 * @param {(line: string, message: string) => void} [onInvalid] called for each broken line
 * @returns {RegExp[]} compiled expressions
 */
function parseAllowlist(text, onInvalid) {
    const result = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        try {
            result.push(new RegExp(line));
        } catch (e) {
            onInvalid?.(line, e.message);
        }
    }
    return result;
}

/**
 * Expression of a scope of the table "Write permissions": an instance or object id ("hm-rpc.0" covers
 * everything below it) or a pattern where "*" stands for any text ("hm-rpc.0.*.STATE").
 *
 * @param {string} scope scope as entered
 * @returns {RegExp | null} expression, or null for an empty scope
 */
function scopePattern(scope) {
    const text = String(scope || '').trim();
    if (!text) {
        return null;
    }
    const escaped = text
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(text.includes('*') ? `^${escaped}$` : `^${escaped}(\\..*)?$`);
}

/** An adapter instance such as "hm-rpc.0": the only scope whose row can allow a restart. */
const INSTANCE = /^[a-z0-9][a-z0-9_-]*\.\d+$/i;

/** Instances the agent never restarts: itself and admin (the user would lose the page); hosts are no instances. */
const NEVER_RESTART = /^(pi-agent|admin)\.\d+$/i;

/**
 * Rows of the table "Write permissions" as expressions for the allowlist and the confirmation list, and the
 * instances that may be restarted. "Confirmation required" counts only where writing is allowed; "Restart allowed"
 * counts only for a row whose scope is a whole instance, and never for pi-agent or admin.
 *
 * @param {unknown} rows table rows { scope, write, confirm, restart }
 * @returns {{ allow: RegExp[], confirm: RegExp[], restart: string[] }} expressions and instances
 */
function parseWriteRules(rows) {
    const allow = [];
    const confirm = [];
    const restart = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const pattern = row?.write ? scopePattern(row.scope) : null;
        if (pattern) {
            allow.push(pattern);
            if (row.confirm) {
                confirm.push(pattern);
            }
        }
        const scope = String(row?.scope ?? '').trim();
        if (row?.restart && isRestartable(scope)) {
            restart.push(scope.toLowerCase());
        }
    }
    return { allow, confirm, restart };
}

/**
 * Whether a scope names an instance the agent may be allowed to restart.
 *
 * @param {string} scope scope of a row, e.g. "hm-rpc.0"
 * @returns {boolean} true for a whole instance other than pi-agent and admin
 */
function isRestartable(scope) {
    return INSTANCE.test(scope) && !NEVER_RESTART.test(scope);
}

/**
 * One checkbox column of the table "Write permissions" for all rows at once: when every row where the column counts
 * has it set, it is cleared there, otherwise it is set there. "confirm" counts only where writing is allowed,
 * "restart" only for a whole instance other than pi-agent and admin; other rows stay as they are.
 *
 * @param {unknown} rows rows of the admin page, not saved yet
 * @param {string} column "write", "confirm" or "restart"
 * @returns {Array<Record<string, unknown>>} the rows with the column switched
 */
function toggleColumn(rows, column) {
    if (!['write', 'confirm', 'restart'].includes(column)) {
        throw new Error(`Unknown column ${column}`);
    }
    const table = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
    const counts = row =>
        column === 'write' ||
        (column === 'confirm' && !!row.write) ||
        (column === 'restart' && isRestartable(String(row.scope ?? '').trim()));
    const value = !table.filter(counts).every(row => row[column] === true);
    return table.map(row => (counts(row) ? { ...row, [column]: value } : row));
}

/**
 * Decide whether the agent may write a state. An empty allowlist denies everything.
 *
 * @param {string} id state id
 * @param {RegExp[]} allowlist compiled allowlist
 * @returns {boolean} true when the id matches at least one expression
 */
function isWriteAllowed(id, allowlist) {
    return allowlist.some(re => re.test(id));
}

/**
 * Stable request id for a trigger, so a retry after a crash finds the original submission.
 *
 * @param {import('node:crypto')} crypto node:crypto module
 * @param {number} ts timestamp of the triggering state
 * @param {unknown} val value of the triggering state
 * @returns {string} request id
 */
function requestIdFor(crypto, ts, val) {
    return `chat-${crypto
        .createHash('sha1')
        .update(`${ts}:${String(val)}`)
        .digest('hex')
        .slice(0, 16)}`;
}

module.exports = {
    parseAllowlist,
    scopePattern,
    parseWriteRules,
    isRestartable,
    toggleColumn,
    isWriteAllowed,
    requestIdFor,
};
