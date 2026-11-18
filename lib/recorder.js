'use strict';

// The data of ioBroker.recorder for the tools house_events, house_snapshot, house_anomalies and usual_value: the
// recorder keeps every relevant state of the house without configuring each one, who switched it, and what is usual.
// Here are the pure parts: times in the past, compact rows for the model, the hour of the week.

const { parseLocalTime, formatLocal } = require('./time');

const DAY = 86_400_000;
/** The categories of the recorder (src/lib/categories.ts there) */
const CATEGORIES = [
    'light',
    'shading',
    'climate',
    'windowsDoors',
    'motion',
    'security',
    'sockets',
    'media',
    'weather',
    'energy',
];
/** Who caused a change, as the recorder classifies it */
const SOURCES = ['user', 'script', 'adapter', 'system'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * A time in the past as the model or the user writes it: "22:00" is the last 22:00 (yesterday when it is not
 * 22:00 yet), "17.11. 22:00" the last 17 November; "2026-11-17 22:00", "17.11.2026 22:00" and ISO times as they are.
 *
 * @param {unknown} input time text; empty = now
 * @param {string} zone IANA time zone of the house
 * @param {number} [now] current instant (ms)
 * @returns {number} instant (ms), NaN when the text is not understood
 */
function pastTime(input, zone, now = Date.now()) {
    const text = String(input ?? '').trim();
    if (!text) {
        return now;
    }
    if (/^\d{10,13}$/.test(text)) {
        const n = Number(text);
        return n < 1e12 ? n * 1000 : n;
    }
    let ts = parseLocalTime(text, zone, now);
    if (Number.isNaN(ts) || ts <= now) {
        return ts;
    }
    // parseLocalTime looks ahead: a bare clock time or a date without a year is the next one, we want the last one
    if (/^\d{1,2}:\d{2}$/.test(text)) {
        return ts - DAY;
    }
    const m = /^(\d{1,2})\.(\d{1,2})\.,?\s+(\d{1,2}):(\d{2})$/.exec(text);
    if (m) {
        const year = Number(formatLocal(now, zone, { zone: false }).slice(0, 4));
        for (const y of [year, year - 1]) {
            ts = parseLocalTime(`${m[1]}.${m[2]}.${y} ${m[3]}:${m[4]}`, zone, now);
            if (ts <= now) {
                return ts;
            }
        }
    }
    return ts;
}

/**
 * A value as the recorder reports it: the text of its states, or the number with its unit.
 *
 * @param {{ val?: unknown, text?: string, unit?: string | null }} entry event or snapshot entry
 * @returns {unknown} value for the model
 */
function valueOf(entry) {
    if (entry.text) {
        return entry.text;
    }
    const val = entry.val ?? null;
    if (entry.unit && (typeof val === 'number' || typeof val === 'string')) {
        return `${val} ${entry.unit}`;
    }
    return val;
}

/**
 * Who changed it: the kind (user, script, adapter, system) and the user or the sender.
 *
 * @param {{ src?: string, user?: string, from?: string }} entry event or snapshot entry
 * @returns {string | undefined} e.g. "user (admin, admin.0)"
 */
function whoOf(entry) {
    if (!entry.src && !entry.from) {
        return undefined;
    }
    const user = entry.user ? String(entry.user).replace(/^system\.user\./, '') : '';
    const from = entry.from ? String(entry.from).replace(/^system\.adapter\./, '') : '';
    const detail = [user, from].filter(Boolean).join(', ');
    return `${entry.src || 'unknown'}${detail ? ` (${detail})` : ''}`;
}

/**
 * One change of `getEvents` as a compact row.
 *
 * @param {Record<string, unknown>} e event of the recorder
 * @param {string} zone time zone
 * @returns {Record<string, unknown>} row
 */
function eventRow(e, zone) {
    return clean({
        time: formatLocal(Number(e.ts), zone, { zone: false }),
        name: e.name || e.id,
        room: e.room || undefined,
        value: valueOf(e),
        who: whoOf(e),
        id: e.id,
    });
}

/**
 * One state of `getSnapshot` as a compact row.
 *
 * @param {Record<string, unknown>} s snapshot entry of the recorder
 * @param {string} zone time zone
 * @returns {Record<string, unknown>} row
 */
function snapshotRow(s, zone) {
    return clean({
        name: s.name || s.id,
        room: s.room || undefined,
        value: valueOf(s),
        changed: s.lc ? formatLocal(Number(s.lc), zone, { zone: false }) : undefined,
        who: s.lc ? whoOf(s) : undefined,
        id: s.id,
    });
}

/**
 * One anomaly of `getAnomalies` as a compact row.
 *
 * @param {Record<string, unknown>} a anomaly of the recorder
 * @param {string} zone time zone
 * @returns {Record<string, unknown>} row
 */
function anomalyRow(a, zone) {
    return clean({
        time: formatLocal(Number(a.ts), zone, { zone: false }),
        rule: a.rule,
        text: a.text,
        name: a.name || a.oid || undefined,
        room: a.room || undefined,
        value: a.val ?? undefined,
        state: a.endTs ? `ended ${formatLocal(Number(a.endTs), zone, { zone: false })}` : 'open',
        acknowledged: a.ackTs ? true : undefined,
        id: a.oid || undefined,
    });
}

/**
 * The hour of the week as the recorder counts it: 0 = Monday 0:00-1:00, 167 = Sunday 23:00-24:00, local time.
 *
 * @param {number} ts instant (ms)
 * @param {string} zone time zone of the house
 * @returns {number} 0..167
 */
function hourOfWeek(ts, zone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        hourCycle: 'h23',
    }).formatToParts(new Date(ts));
    const day = WEEKDAYS.indexOf(String(parts.find(p => p.type === 'weekday')?.value));
    const hour = Number(parts.find(p => p.type === 'hour')?.value) % 24;
    return Math.max(0, day) * 24 + hour;
}

/**
 * @param {number} how hour of the week
 * @returns {string} e.g. "Tue 22:00-23:00"
 */
function hourLabel(how) {
    const h = how % 24;
    return `${WEEKDAYS[Math.floor(how / 24) % 7]} ${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00`;
}

/**
 * The usual values around an hour of the week from `getProfile`.
 *
 * @param {{ profile?: Array<Record<string, unknown>> }} answer answer of the recorder
 * @param {number} how hour of the week of interest
 * @param {number} [around] hours before and after
 * @returns {Array<Record<string, unknown>>} rows, the hour of interest marked
 */
function profileAround(answer, how, around = 1) {
    const cells = new Map((answer.profile || []).map(c => [Number(c.how), c]));
    const rows = [];
    for (let d = -around; d <= around; d++) {
        const h = (((how + d) % 168) + 168) % 168;
        const c = cells.get(h);
        rows.push(
            clean({
                hour: hourLabel(h),
                asked: d === 0 || undefined,
                weeks: c?.n ?? 0,
                mean: round(c?.mean),
                deviation: round(c?.sd),
                min: round(c?.min),
                max: round(c?.max),
                // share of the weeks with activity (a light on, a window open) in this hour
                activeShare: c && typeof c.pActive === 'number' ? round(c.pActive) : undefined,
            }),
        );
    }
    return rows;
}

/**
 * @param {unknown} v number or nothing
 * @returns {number | undefined} rounded to 2 decimals
 */
function round(v) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
}

/**
 * @param {Record<string, unknown>} row row
 * @returns {Record<string, unknown>} the row without undefined fields
 */
function clean(row) {
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

module.exports = {
    CATEGORIES,
    SOURCES,
    pastTime,
    valueOf,
    whoOf,
    eventRow,
    snapshotRow,
    anomalyRow,
    hourOfWeek,
    hourLabel,
    profileAround,
};
