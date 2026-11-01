'use strict';

/**
 * Backups of the conversations: names, order, the snapshot of the store and the restore at the start.
 *
 * The conversations live in `session.sqlite` in the instance data directory, which the ioBroker backup does not
 * contain. A backup is a consistent copy of it, gzip-compressed, in the ioBroker file storage below the mount point
 * `<namespace>.storage` (`meta.user`, so ioBroker / BackItUp backups take it along), folder `backups/`. Every file has
 * the time stamp in its name, so the alphabetical order is the age:
 *
 * - `pi-agent-backup-<time>.sqlite.gz`     made by hand — never deleted automatically
 * - `pi-agent-auto-<time>.sqlite.gz`       automatic — the oldest beyond `backupKeep` are deleted
 * - `pi-agent-prerestore-<time>.sqlite.gz` the store saved right before a restore — never deleted automatically,
 *   so a wrong restore can be undone
 * - `pi-agent-prepurge-<time>.sqlite.gz`   the store saved right before old conversations are deleted (lib/purge.js)
 *
 * The same names are used on the external SFTP server (lib/remote-backup.js).
 *
 * Besides the tables of Pi Durable, a backup holds the table `pi_agent_backup` with the map "messenger chat ->
 * conversation" (state telegram.chats), so the chats go on with their conversations after a restore. The table is
 * removed again when the backup is put in place.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** Folder of the backups below the mount point. */
const BACKUP_DIR = 'backups';

/** File of the conversation store in the instance data directory. */
const STORE_FILE = 'session.sqlite';

/** A checked backup waiting for the next start of the instance, next to the store. */
const RESTORE_FILE = 'session.restore.sqlite';

/** Table of a backup with what is not in the store itself. */
const META_TABLE = 'pi_agent_backup';

/** Pattern of a backup file of this adapter (nothing else is ever listed, read or deleted). */
const BACKUP_NAME = /^pi-agent-(backup|auto|prerestore|prepurge)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.sqlite\.gz$/;

/**
 * File name of a backup, with the time (UTC) in the name.
 *
 * @param {'manual'|'auto'|'prerestore'|'prepurge'} kind made by hand, automatic, or safety copy before a restore or a deletion
 * @param {Date} [date] time of the backup
 * @returns {string} e.g. `pi-agent-auto-2026-10-28T02-30-00.sqlite.gz`
 */
function backupName(kind, date = new Date()) {
    const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-');
    const prefix = kind === 'manual' ? 'backup' : kind;
    return `pi-agent-${prefix}-${stamp}.sqlite.gz`;
}

/**
 * Check whether a name is a backup file of this adapter (also refuses paths and `..`).
 *
 * @param {unknown} name file name
 * @returns {boolean} true for `pi-agent-(backup|auto|prerestore|prepurge)-<time>.sqlite.gz`
 */
function isBackupName(name) {
    return typeof name === 'string' && BACKUP_NAME.test(name);
}

/**
 * The backup files of a listing, newest first (equal times: by name).
 *
 * @param {string[]} names file names
 * @returns {string[]} backup names, newest first
 */
function sortBackupsNewestFirst(names) {
    const stamp = name => String(BACKUP_NAME.exec(name)?.[2]);
    return names.filter(isBackupName).sort((a, b) => {
        const ta = stamp(a);
        const tb = stamp(b);
        return ta === tb ? (a < b ? 1 : -1) : ta < tb ? 1 : -1;
    });
}

/**
 * The automatic backups that exceed the number to keep (the oldest ones). Backups made by hand, safety copies and
 * foreign files are never selected.
 *
 * @param {string[]} names file names in the backup folder
 * @param {unknown} keep automatic backups to keep, 0 (or less, or not a number) = keep all
 * @returns {string[]} the names to delete
 */
function selectLocalBackupsToPrune(names, keep) {
    const limit = Number(keep);
    if (!Number.isFinite(limit) || limit <= 0) {
        return [];
    }
    return sortBackupsNewestFirst(names.filter(name => name.startsWith('pi-agent-auto-'))).slice(Math.floor(limit));
}

/**
 * Text for a backup in a selection list.
 *
 * @param {string} name backup file name
 * @param {number} [size] size in bytes
 * @returns {string} e.g. `2026-10-28 02:30:00 UTC · automatic · 120 kB`
 */
function backupLabel(name, size) {
    const match = BACKUP_NAME.exec(String(name));
    if (!match) {
        return String(name);
    }
    const [date, time] = match[2].split('T');
    const kind = { backup: 'by hand', auto: 'automatic', prerestore: 'before restore', prepurge: 'before deleting' }[
        match[1]
    ];
    const kb = Number.isFinite(size) && Number(size) > 0 ? ` · ${Math.max(1, Math.round(Number(size) / 1024))} kB` : '';
    return `${date} ${time.replace(/-/g, ':')} UTC · ${kind}${kb}`;
}

/**
 * A consistent snapshot of the conversation store with the chat map, gzip-compressed. VACUUM INTO reads one
 * transaction of a second, read-only connection, so the running agent may go on writing while the copy is made.
 *
 * @param {string} dbFile path of the store
 * @param {{ chats: Record<string, string>, memory?: unknown[], scripts?: object }} extras what the backup holds
 *     besides the store: the chat map, the long-term memory and the previous versions of the scripts
 * @returns {{ data: Buffer, rawSize: number }} compressed snapshot and its uncompressed size
 */
function createSnapshot(dbFile, extras) {
    if (!fs.existsSync(dbFile)) {
        throw new Error(`No conversation store at ${dbFile}`);
    }
    const { DatabaseSync } = require('node:sqlite');
    const tmp = path.join(path.dirname(dbFile), `session.backup-${process.pid}.sqlite`);
    fs.rmSync(tmp, { force: true });
    try {
        const source = new DatabaseSync(dbFile, { readOnly: true });
        try {
            source.exec('PRAGMA busy_timeout = 10000');
            source.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        } finally {
            source.close();
        }
        const copy = new DatabaseSync(tmp);
        try {
            copy.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            const put = copy.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
            put.run('format', '1');
            put.run('created', new Date().toISOString());
            put.run('chats', JSON.stringify(extras.chats || {}));
            if (Array.isArray(extras.memory)) {
                put.run('memory', JSON.stringify(extras.memory));
            }
            if (extras.scripts) {
                put.run('scripts', JSON.stringify(extras.scripts));
            }
        } finally {
            copy.close();
        }
        const raw = fs.readFileSync(tmp);
        return { data: zlib.gzipSync(raw, { level: 9 }), rawSize: raw.length };
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/**
 * Check a backup and put it next to the store, where the next start takes it (see applyPendingRestore).
 * Nothing is replaced here: the running agent keeps the store open.
 *
 * @param {Buffer} data content of a backup file
 * @param {string} dir instance data directory
 * @returns {{ conversations: number, chats: number }} what the backup holds
 */
function stageRestore(data, dir) {
    let raw;
    try {
        raw = zlib.gunzipSync(data);
    } catch {
        throw new Error('the file is not a gzip-compressed backup');
    }
    const target = path.join(dir, RESTORE_FILE);
    const partial = `${target}.part`;
    fs.writeFileSync(partial, raw);
    // reading a database in WAL mode leaves its -wal and -shm files behind
    const sidecars = () => ['-wal', '-shm'].forEach(end => fs.rmSync(`${partial}${end}`, { force: true }));
    try {
        const info = inspect(partial);
        sidecars();
        fs.renameSync(partial, target);
        return info;
    } catch (error) {
        sidecars();
        fs.rmSync(partial, { force: true });
        throw error;
    }
}

/**
 * Check that a file is a backup of this adapter and count what it holds.
 *
 * @param {string} file uncompressed backup
 * @returns {{ conversations: number, chats: number }} counts
 */
function inspect(file) {
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true });
    } catch {
        throw new Error('the file is not a SQLite database');
    }
    try {
        let check;
        try {
            check = db.prepare('PRAGMA integrity_check').get();
        } catch {
            throw new Error('the file is not a SQLite database');
        }
        if (Object.values(Object(check))[0] !== 'ok') {
            throw new Error('the database in the backup is damaged');
        }
        const tables = new Set(
            db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map(r => String(r.name)),
        );
        if (!tables.has(META_TABLE)) {
            throw new Error('the file is not a backup of the Pi Agent conversations');
        }
        const chats = readChats(db);
        const conversations = tables.has('conversations')
            ? Number(Object.values(Object(db.prepare('SELECT count(*) FROM conversations').get()))[0])
            : 0;
        return { conversations, chats: Object.keys(chats).length };
    } finally {
        db.close();
    }
}

/**
 * The chat map stored in a backup.
 *
 * @param {import('node:sqlite').DatabaseSync} db open backup
 * @returns {Record<string, string>} chat key -> conversation id
 */
function readChats(db) {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'chats'`).get();
    try {
        const chats = JSON.parse(String(row?.value || '{}'));
        return chats && typeof chats === 'object' && !Array.isArray(chats) ? chats : {};
    } catch {
        return {};
    }
}

/**
 * The long-term memory stored in a backup (since 0.6.0).
 *
 * @param {import('node:sqlite').DatabaseSync} db open backup
 * @returns {unknown[] | null} facts, null for a backup without memory (it then stays as it is)
 */
function readMemory(db) {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'memory'`).get();
    try {
        const memory = row ? JSON.parse(String(row.value)) : null;
        return Array.isArray(memory) ? memory : null;
    } catch {
        return null;
    }
}

/**
 * The previous versions of the scripts stored in a backup (since 0.8.0).
 *
 * @param {import('node:sqlite').DatabaseSync} db open backup
 * @returns {object | null} versions by script id, null for a backup without them (they then stay as they are)
 */
function readScripts(db) {
    const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'scripts'`).get();
    try {
        const scripts = row ? JSON.parse(String(row.value)) : null;
        return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : null;
    } catch {
        return null;
    }
}

/**
 * At the start, before the store is opened: put a staged backup in place of the store.
 *
 * @param {string} dir instance data directory
 * @returns {{ chats: Record<string, string>, memory: unknown[] | null, scripts: object | null } | null} the chat
 *     map, the long-term memory and the script versions of the backup, null when nothing was staged
 */
function applyPendingRestore(dir) {
    const staged = path.join(dir, RESTORE_FILE);
    if (!fs.existsSync(staged)) {
        return null;
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(staged);
    let chats;
    let memory;
    let scripts;
    try {
        chats = readChats(db);
        memory = readMemory(db);
        scripts = readScripts(db);
        db.exec(`DROP TABLE IF EXISTS ${META_TABLE}`);
    } finally {
        db.close();
    }
    const store = path.join(dir, STORE_FILE);
    for (const file of [store, `${store}-wal`, `${store}-shm`, `${store}-journal`]) {
        fs.rmSync(file, { force: true });
    }
    fs.renameSync(staged, store);
    return { chats, memory, scripts };
}

module.exports = {
    BACKUP_DIR,
    STORE_FILE,
    RESTORE_FILE,
    backupName,
    isBackupName,
    sortBackupsNewestFirst,
    selectLocalBackupsToPrune,
    backupLabel,
    createSnapshot,
    stageRestore,
    applyPendingRestore,
};
