'use strict';

// Scripts of the javascript adapter, created and changed by the agent (since 0.8.0). A script runs with the rights of
// the javascript adapter, not of pi-agent: the write permissions do not reach it. What protects the house is the
// person who sees the code before it is saved, a narrow scope (the folder script.js.pi-agent, other scripts only
// with an extra setting) and the previous versions, kept for revert_script and part of the backups.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Root of the scripts of the javascript adapter. */
const SCRIPT_ROOT = 'script.js';
/** Folder of the scripts of the agent. */
const OWN_FOLDER = `${SCRIPT_ROOT}.pi-agent`;
/** File of the previous versions in the instance data directory. */
const HISTORY_FILE = 'script-history.json';
/** Versions kept per script. */
const MAX_VERSIONS = 5;
/** Longest source the agent writes. */
const MAX_SOURCE = 100_000;
/** Lines of the diff shown in a confirmation at most. */
const MAX_DIFF_LINES = 400;
/** Engine types the agent may write; Blockly and Rules keep their own format and stay read-only. */
const WRITABLE_ENGINES = ['Javascript/js', 'TypeScript/ts'];

/**
 * The id of a script: a full id ("script.js.heating.boiler") or a name for the folder of the agent ("Evening light").
 *
 * @param {unknown} value argument of the model
 * @returns {string} id, "" when nothing usable is left
 */
function scriptIdOf(value) {
    const text = String(value ?? '').trim();
    const segment = s =>
        s
            .trim()
            .replace(/\s+/g, '_')
            .replace(/[^\p{L}\p{N}_-]/gu, '');
    if (text.startsWith(`${SCRIPT_ROOT}.`)) {
        const parts = text
            .slice(SCRIPT_ROOT.length + 1)
            .split('.')
            .map(segment);
        return parts.length && parts.every(Boolean) ? `${SCRIPT_ROOT}.${parts.join('.')}` : '';
    }
    const name = segment(text);
    return name ? `${OWN_FOLDER}.${name}` : '';
}

/**
 * @param {string} id script id
 * @returns {boolean} true for a script in the folder of the agent
 */
function isOwn(id) {
    return id.startsWith(`${OWN_FOLDER}.`);
}

/**
 * @param {string} id script id
 * @returns {string} name to speak or show, e.g. "Evening light" for script.js.pi-agent.Evening_light
 */
function scriptName(id) {
    return id.split('.').at(-1).replace(/_/g, ' ');
}

/**
 * Line diff of two sources: "+ " added, "- " removed, "  " unchanged, with two lines of context around each change.
 *
 * @param {string} before old source ("" for a new script)
 * @param {string} after new source
 * @returns {string} diff, cut after MAX_DIFF_LINES lines
 */
function lineDiff(before, after) {
    const a = before ? before.split(/\r?\n/) : [];
    const b = after ? after.split(/\r?\n/) : [];
    let rows;
    if (a.length * b.length > 4_000_000) {
        // too large for the table below: everything old out, everything new in
        rows = [...a.map(line => ['-', line]), ...b.map(line => ['+', line])];
    } else {
        // longest common subsequence, from the end
        const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--) {
            for (let j = b.length - 1; j >= 0; j--) {
                lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        rows = [];
        let i = 0;
        let j = 0;
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && a[i] === b[j]) {
                rows.push([' ', a[i++]]);
                j++;
            } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
                // removed lines first, as in a unified diff
                rows.push(['-', a[i++]]);
            } else {
                rows.push(['+', b[j++]]);
            }
        }
    }
    const near = rows.map((_, k) => rows.slice(Math.max(0, k - 2), k + 3).some(([mark]) => mark !== ' '));
    const out = [];
    rows.forEach(([mark, line], k) => {
        if (near[k]) {
            out.push(`${mark} ${line}`);
        } else if (out.at(-1) !== '…') {
            out.push('…');
        }
    });
    if (out.length > MAX_DIFF_LINES) {
        return [...out.slice(0, MAX_DIFF_LINES), `… (${out.length - MAX_DIFF_LINES} more lines)`].join('\n');
    }
    return out.join('\n');
}

/**
 * The warnings of scriptWarnings that are words, not names of calls: English in the messenger chat and the log, the
 * question by text (lib/text-confirmation.js) speaks them in its language.
 */
const WARNING = {
    fileAccess: 'file access',
    objectChanges: 'object changes',
    network: 'network',
    /** followed by ": " and the ids */
    outside: 'setState outside the write permissions',
    computedId: 'setState with a computed id',
};

/** Calls a person should look at twice. Only a hint: such a search is easy to get around. */
const RISKY = [
    { re: /\bexec\s*\(/, label: 'exec' },
    { re: /\brequire\s*\(/, label: 'require' },
    { re: /child_process|\bspawn\s*\(/, label: 'child_process' },
    { re: /\b(?:writeFile|delFile|unlink|rename|mkdir)\w*\s*\(/, label: WARNING.fileAccess },
    {
        re: /\b(?:setObject|extendObject|delObject|deleteObject|setForeignObject|extendForeignObject)\w*\s*\(/,
        label: WARNING.objectChanges,
    },
    { re: /\bsendTo\w*\s*\(/, label: 'sendTo' },
    { re: /\b(?:httpGet|httpPost|fetch|axios)\b/, label: WARNING.network },
];

/**
 * What the confirmation warns about: risky calls, and the states the script writes that pi-agent itself may not
 * write (by its write permissions), or writes by a computed id.
 *
 * @param {string} source source of the script
 * @param {(id: string) => boolean} allowed whether pi-agent may write a state
 * @returns {string[]} warnings, e.g. ["exec", "setState outside the write permissions: hm-rpc.0.ABC.1.STATE"]
 */
function scriptWarnings(source, allowed) {
    const warnings = RISKY.filter(({ re }) => re.test(source)).map(({ label }) => label);
    const outside = new Set();
    let computed = false;
    for (const m of source.matchAll(/\bset(?:Foreign)?State(?:Async|Delayed|Changed)?\s*\(\s*([^,)]*)/g)) {
        const literal = /^(['"`])([^'"`$]+)\1$/.exec(m[1].trim());
        if (!literal) {
            computed = true;
        } else if (!allowed(literal[2])) {
            outside.add(literal[2]);
        }
    }
    if (outside.size) {
        warnings.push(`${WARNING.outside}: ${[...outside].join(', ')}`);
    }
    if (computed) {
        warnings.push(WARNING.computedId);
    }
    return warnings;
}

/**
 * Compile a script wrapped in an async function, without running it.
 *
 * @param {string} wrapped "async function …" around the source, which starts on its second line
 * @returns {string} the error with its line in the source, "" when it compiles
 */
function compileError(wrapped) {
    try {
        new vm.Script(`(${wrapped})`, { filename: 'script.js' });
        return '';
    } catch (e) {
        const line = /script\.js:(\d+)/.exec(String(e.stack))?.[1];
        return `${e.message}${line ? ` (line ${Number(line) - 1})` : ''}`;
    }
}

/**
 * Syntax check, the way the javascript adapter runs a script (inside an async function, so "await" and "return"
 * work at the top). TypeScript loses its types first (stripTypeScriptTypes of Node.js); types themselves are not
 * checked, and syntax that only the TypeScript compiler of the javascript adapter knows (enum, namespace) is not
 * checked at all.
 *
 * @param {string} source source of the script
 * @param {string} engineType engine type, "Javascript/js" or "TypeScript/ts"
 * @returns {string} the error with its line, "" when the source compiles or cannot be checked
 */
function syntaxError(source, engineType) {
    const wrapped = `async function script() {\n${source}\n}`;
    if (engineType === 'Javascript/js') {
        return compileError(wrapped);
    }
    const { stripTypeScriptTypes } = require('node:module');
    if (engineType !== 'TypeScript/ts' || typeof stripTypeScriptTypes !== 'function') {
        return '';
    }
    let stripped;
    // Node.js 22 and 24 call it experimental; the warning would land in the log of ioBroker at every first check
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    try {
        stripped = stripTypeScriptTypes(wrapped);
    } catch (e) {
        if (e.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX') {
            return '';
        }
        // the stack starts with ":<line>" of the wrapped source
        const line = /^:(\d+)/.exec(String(e.stack))?.[1];
        return `${e.message}${line ? ` (line ${Number(line) - 1})` : ''}`;
    } finally {
        process.emitWarning = emitWarning;
    }
    return compileError(stripped);
}

/**
 * The question of a script confirmation in a messenger chat or in the log, in English.
 *
 * @param {string} action "scriptSave", "scriptEnable" or "scriptRevert"
 * @param {{ id: string, isNew?: boolean, engineType?: string, running?: boolean, enabled?: boolean, warnings?: string[], diff?: string }} val what is confirmed
 * @param {{ mark: (part: string) => string, pre: (text: string) => string, maxDiff: number }} format how parts are shown
 * @returns {string} question
 */
function scriptQuestion(action, val, { mark, pre, maxDiff }) {
    const lines = [];
    if (action === 'scriptEnable') {
        return `⚠️ ${val.enabled ? 'Start' : 'Stop'} the script ${mark(val.id)}?`;
    }
    if (action === 'scriptRevert') {
        lines.push(`⚠️ Revert the script ${mark(val.id)} to its previous version? It is stopped afterwards.`);
    } else {
        lines.push(
            `⚠️ Save the script ${mark(val.id)} (${val.isNew ? `new${val.engineType === 'TypeScript/ts' ? ', TypeScript' : ''}, it stays stopped` : 'change'})?`,
            ...(val.running ? ['The script is running and restarts with the new code at once.'] : []),
        );
    }
    for (const warning of val.warnings || []) {
        lines.push(`⚠ ${warning}`);
    }
    const diff = String(val.diff || '');
    lines.push(
        pre(diff.length > maxDiff ? `${diff.slice(0, maxDiff)}\n… (cut, the whole change is in the admin chat)` : diff),
    );
    return lines.join('\n');
}

/**
 * The previous versions of the scripts, in a file of the instance data directory.
 *
 * @param {string} dir instance data directory
 * @returns {object} history
 */
function createScriptHistory(dir) {
    const file = path.join(dir, HISTORY_FILE);
    // script id -> versions, oldest first
    let versions = Object.create(null);

    const save = () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(versions));
    };

    return {
        /** Read the file; an unreadable one starts empty. */
        load() {
            try {
                versions = this.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                versions = {};
            }
        },

        /**
         * @param {unknown} value stored history (text or object)
         * @returns {Record<string, Array<{ ts: number, source: string }>>} the usable entries
         */
        parse(value) {
            let data = value;
            if (typeof value === 'string') {
                try {
                    data = JSON.parse(value);
                } catch {
                    return {};
                }
            }
            const result = Object.create(null);
            for (const [id, list] of Object.entries(Object(data))) {
                const usable = (Array.isArray(list) ? list : [])
                    .filter(v => v && typeof v.source === 'string')
                    .map(v => ({ ts: Number(v.ts) || 0, source: v.source }))
                    .slice(-MAX_VERSIONS);
                if (usable.length) {
                    result[id] = usable;
                }
            }
            return result;
        },

        /** @returns {Record<string, Array<{ ts: number, source: string }>>} all versions, for a backup */
        all() {
            return versions;
        },

        /** @param {unknown} value history of a backup */
        replace(value) {
            versions = this.parse(value);
            save();
        },

        /**
         * @param {string} id script id
         * @returns {number} versions kept for it
         */
        count(id) {
            return versions[id]?.length || 0;
        },

        /**
         * Keep the source a script had before a change.
         *
         * @param {string} id script id
         * @param {string} source source before the change
         */
        push(id, source) {
            versions[id] = [...(versions[id] || []), { ts: Date.now(), source }].slice(-MAX_VERSIONS);
            save();
        },

        /**
         * @param {string} id script id
         * @returns {string | undefined} the newest kept version
         */
        peek(id) {
            return versions[id]?.at(-1)?.source;
        },

        /**
         * Remove the newest kept version, after it was written back.
         *
         * @param {string} id script id
         */
        pop(id) {
            versions[id]?.pop();
            if (!versions[id]?.length) {
                delete versions[id];
            }
            save();
        },
    };
}

module.exports = {
    SCRIPT_ROOT,
    OWN_FOLDER,
    HISTORY_FILE,
    MAX_SOURCE,
    WRITABLE_ENGINES,
    WARNING,
    scriptIdOf,
    isOwn,
    scriptName,
    lineDiff,
    scriptWarnings,
    syntaxError,
    scriptQuestion,
    createScriptHistory,
};
