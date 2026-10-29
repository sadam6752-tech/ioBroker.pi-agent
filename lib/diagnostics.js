'use strict';

/**
 * Read-only diagnostics for the tools get_logs and list_notifications: the newest lines of the ioBroker log file and
 * the notifications of js-controller (system.host.<host>.notifications.<scope>).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Levels from the least to the most important. */
const LEVELS = ['silly', 'debug', 'info', 'warn', 'error'];
/** How much of the end of the log file is read. */
const TAIL_BYTES = 1024 * 1024;
/** Longest message of a log line that goes to the model. */
const MAX_MESSAGE = 300;

// "2026-10-28 14:58:35.471  - info: influxdb.0 (18978) Connecting ..." (colours removed)
const LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+- (silly|debug|info|warn|error): (\S+) (.*)$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * The log file of ioBroker: iobroker.current.log, else the newest iobroker.<date>.log, in the log folder next to
 * iobroker-data.
 *
 * @param {string} dataDir absolute iobroker-data folder
 * @returns {string | null} path of the log file
 */
function findLogFile(dataDir) {
    const dir = path.join(dataDir, '..', 'log');
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null;
    }
    if (names.includes('iobroker.current.log')) {
        return path.join(dir, 'iobroker.current.log');
    }
    const dated = names.filter(n => /^iobroker\.\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    return dated.length ? path.join(dir, dated[dated.length - 1]) : null;
}

/**
 * The newest log lines, filtered.
 *
 * @param {string} file log file
 * @param {{ instance?: string, level?: string, count?: number, search?: string }} filter instance or adapter
 *     ("zigbee.0", "zigbee"), lowest level (default warn), number of lines (at most 50), a word in the message
 * @returns {Array<{ time: string, level: string, source: string, message: string }>} lines, oldest first
 */
function readLog(file, filter = {}) {
    const minLevel = LEVELS.indexOf(LEVELS.includes(String(filter.level)) ? String(filter.level) : 'warn');
    const count = Math.min(Math.max(Math.round(Number(filter.count) || 30), 1), 50);
    const instance = String(filter.instance || '')
        .trim()
        .replace(/^system\.adapter\./, '')
        .toLowerCase();
    const search = String(filter.search || '')
        .trim()
        .toLowerCase();
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = LINE.exec(raw.replace(ANSI, ''));
        if (!m) {
            continue;
        }
        const [, time, level, source, message] = m;
        const src = source.toLowerCase();
        if (LEVELS.indexOf(level) < minLevel) {
            continue;
        }
        if (instance && src !== instance && !src.startsWith(`${instance}.`)) {
            continue;
        }
        if (search && !message.toLowerCase().includes(search)) {
            continue;
        }
        lines.push({
            time,
            level,
            source,
            message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
        });
    }
    return lines.slice(-count);
}

/**
 * Messages in a notification state of js-controller, flattened: the state holds categories with instances with
 * messages; the exact shape differs between versions, so every array "messages" is collected with its path.
 *
 * @param {string} scope scope of the notification state, e.g. "system"
 * @param {unknown} value parsed value of the state
 * @returns {Array<{ scope: string, category: string, instance: string, message: string, ts?: number }>} messages
 */
function flattenNotifications(scope, value) {
    const found = [];
    const walk = (node, trail) => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (Array.isArray(node.messages)) {
            for (const m of node.messages) {
                const message = typeof m === 'string' ? m : String(Object(m).message ?? '');
                if (message) {
                    found.push({
                        scope,
                        category: trail.find(t => !t.startsWith('system.adapter.')) || '',
                        instance: (trail.find(t => t.startsWith('system.adapter.')) || '').replace(
                            'system.adapter.',
                            '',
                        ),
                        message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
                        ts: Number(Object(m).ts) || undefined,
                    });
                }
            }
        }
        for (const [key, child] of Object.entries(node)) {
            if (key !== 'messages' && child && typeof child === 'object') {
                walk(child, ['categories', 'instances'].includes(key) ? trail : [...trail, key]);
            }
        }
    };
    walk(value, []);
    return found;
}

module.exports = { LEVELS, findLogFile, readLog, flattenNotifications };
