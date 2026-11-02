'use strict';

// Backups of the conversations: names, snapshot, restore at the start, the commands of the tab "Backup" and the copy
// to an SFTP server (a small server inside the test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { startServer } = require('./helpers/sftp-server');
const {
    BACKUP_DIR,
    RESTORE_FILE,
    backupName,
    isBackupName,
    sortBackupsNewestFirst,
    selectLocalBackupsToPrune,
    backupLabel,
    createSnapshot,
    stageRestore,
    applyPendingRestore,
} = require('../lib/backup');
const { autoBackupDelay } = require('../lib/backup-schedule');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-backup-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const STORAGE = `${NAMESPACE}.storage`;

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message = {}) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({ command, message, from: 'system.adapter.admin.0', callback: { id: 1 } });
    });
}

/** A store with one table and one row, like a small session.sqlite. */
function smallStore(dir, rows = ['committed']) {
    const file = path.join(dir, 'session.sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE conversations (id TEXT)');
    for (const row of rows) {
        db.prepare('INSERT INTO conversations VALUES (?)').run(row);
    }
    db.close();
    return file;
}

test('backup names: time in the name, only own files, newest first, only automatic ones are pruned', () => {
    const at = h => new Date(Date.UTC(2026, 9, 28, h, 0, 0));
    assert.equal(backupName('auto', at(2)), 'pi-agent-auto-2026-10-28T02-00-00.sqlite.gz');
    assert.equal(backupName('manual', at(2)), 'pi-agent-backup-2026-10-28T02-00-00.sqlite.gz');
    assert.ok(isBackupName(backupName('prerestore', at(2))));
    for (const bad of [
        '../pi-agent-auto-2026-10-28T02-00-00.sqlite.gz',
        'x.sqlite.gz',
        'pi-agent-auto-.sqlite.gz',
        7,
    ]) {
        assert.equal(isBackupName(bad), false, String(bad));
    }
    const names = [1, 3, 2].map(h => backupName('auto', at(h))).concat(backupName('manual', at(0)), 'other.txt');
    assert.deepEqual(sortBackupsNewestFirst(names), [
        backupName('auto', at(3)),
        backupName('auto', at(2)),
        backupName('auto', at(1)),
        backupName('manual', at(0)),
    ]);
    assert.deepEqual(selectLocalBackupsToPrune(names, 2), [backupName('auto', at(1))]);
    assert.deepEqual(selectLocalBackupsToPrune(names, 0), []);
    assert.equal(backupLabel(backupName('auto', at(2)), 3000), '2026-10-28 02:00:00 (UTC) · automatic · 3 kB');
    // the list shows the time of the house: 02:00 UTC is 03:00 in Berlin (winter time)
    assert.equal(
        backupLabel(backupName('manual', at(2)), undefined, 'Europe/Berlin'),
        '2026-10-28 03:00:00 (Europe/Berlin) · by hand',
    );
});

test('autoBackupDelay: off, overdue after five minutes, otherwise from the last backup', () => {
    const now = Date.UTC(2026, 9, 28, 12);
    assert.equal(autoBackupDelay(0, now, now), null);
    assert.equal(autoBackupDelay(24, 0, now), 5 * 60_000);
    assert.equal(autoBackupDelay(24, now - 3_600_000, now), 23 * 3_600_000);
});

test('snapshot: committed data and the chat map, while another connection writes; restore puts it in place', () => {
    const dir = tmp();
    const file = smallStore(dir);
    const writer = new DatabaseSync(file);
    writer.exec('BEGIN');
    writer.prepare('INSERT INTO conversations VALUES (?)').run('open transaction');
    const scripts = { 'script.js.pi-agent.x': [{ ts: 1, source: 'log(1);' }] };
    const { data, rawSize } = createSnapshot(file, { chats: { 'telegram.0/42': 'conv-1' }, scripts });
    writer.exec('COMMIT');
    writer.close();
    assert.ok(rawSize > 0);
    assert.deepEqual(
        fs.readdirSync(dir).filter(f => f.includes('backup')),
        [],
        'no temporary file is left',
    );

    assert.deepEqual(stageRestore(data, dir), { conversations: 1, chats: 1 });
    assert.ok(fs.existsSync(path.join(dir, RESTORE_FILE)));
    const restored = applyPendingRestore(dir);
    assert.deepEqual(restored, { chats: { 'telegram.0/42': 'conv-1' }, memory: null, scripts });
    assert.equal(fs.existsSync(path.join(dir, RESTORE_FILE)), false);
    assert.equal(fs.existsSync(`${file}-wal`), false, 'the log of the replaced store is gone');
    const db = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(
        db
            .prepare('SELECT id FROM conversations')
            .all()
            .map(r => r.id),
        ['committed'],
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'pi_agent_backup'").get().n, 0);
    db.close();
    assert.equal(applyPendingRestore(dir), null, 'nothing staged, nothing done');
});

test('stageRestore refuses what is not a backup of this adapter', () => {
    const dir = tmp();
    assert.throws(() => stageRestore(Buffer.from('plain text'), dir), /gzip/);
    assert.throws(() => stageRestore(zlib.gzipSync(Buffer.from('plain text')), dir), /not a SQLite database/);
    const foreign = fs.readFileSync(smallStore(tmp()));
    assert.throws(() => stageRestore(zlib.gzipSync(foreign), dir), /not a backup of the Pi Agent/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is left behind');
});

test('tab Backup: create, list, restore with a safety copy, and the restore at the next start', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('hi')] });
    const chats = JSON.stringify({ 'telegram.0/42': 'conv-1' });
    await first.agent.setStateAsync('telegram.chats', { val: chats, ack: true });

    const created = await call(first.agent, 'createBackup');
    assert.match(created.result, /Backup saved: pi-agent\.0\.storage\/backups\/pi-agent-backup-/);
    assert.equal(first.db.objects[STORAGE].common.type, 'meta.user');
    const list = await call(first.agent, 'listBackups');
    assert.equal(list.length, 1);
    assert.match(list[0].label, /by hand/);
    assert.ok(first.db.states[`${NAMESPACE}.backup.size`].val > 0);

    // the chats change after the backup; the restore brings the old map back
    await first.agent.setStateAsync('telegram.chats', { val: '{}', ack: true });
    await first.agent.setStateAsync('chat.pending', { val: '[]', ack: true });
    assert.deepEqual(await call(first.agent, 'restoreBackup', { file: '../etc/passwd' }), {
        error: 'Choose a backup from the list',
    });
    const restored = await call(first.agent, 'restoreBackup', { file: list[0].value });
    assert.match(restored.result, /is restored at the restart/);
    assert.ok(
        Object.keys(first.agent.files).some(k => k.includes('pi-agent-prerestore-')),
        'safety copy made',
    );
    assert.ok(fs.existsSync(path.join(dataDir, RESTORE_FILE)));
    await waitFor(async () => first.agent.restarted === 1, 'the restart');
    await stopAgent(first.agent);

    const second = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('hi')] });
    assert.equal(second.db.states[`${NAMESPACE}.telegram.chats`].val, chats);
    assert.equal(second.db.states[`${NAMESPACE}.chat.pending`].val, '');
    assert.ok(second.agent.logs.some(([, msg]) => msg.includes('Conversations restored from a backup')));
    assert.equal(fs.existsSync(path.join(dataDir, RESTORE_FILE)), false);
    await stopAgent(second.agent);
});

test('automatic backup: off by default, planned with an interval, the timer ends with the instance', async () => {
    const f = await faux();
    const off = await startAgent({ dataDir: tmp(), responses: [f.fauxAssistantMessage('hi')] });
    assert.equal(off.agent.backupTimer, undefined);
    await stopAgent(off.agent);

    const on = await startAgent({
        dataDir: tmp(),
        config: { autoBackupInterval: 24, backupKeep: 2 },
        responses: [f.fauxAssistantMessage('hi')],
    });
    assert.ok(on.agent.backupTimer, 'a backup is planned');
    // three automatic backups with keep 2: the oldest goes
    for (let i = 0; i < 3; i++) {
        await on.agent.createBackup('auto');
        await new Promise(resolve => setTimeout(resolve, 1100)); // the name has the time in seconds
    }
    const autos = Object.keys(on.agent.files).filter(k => k.includes('pi-agent-auto-'));
    assert.equal(autos.length, 2);
    await stopAgent(on.agent);
    assert.equal(on.agent.backupTimer._destroyed, true, 'the timer is cleared on unload');
});

test('SFTP: a backup is copied to the server, listed there and restored from it', async () => {
    const disk = { files: new Map(), directories: new Set() };
    const server = await startServer(disk);
    const f = await faux();
    const remote = {
        remoteEnabled: true,
        remoteHost: '127.0.0.1',
        remotePort: server.port,
        remoteUser: 'backup',
        remotePassword: 'secret',
        remoteDirectory: '/backups/pi-agent',
        remoteHostKey: server.fingerprint,
    };
    const dataDir = tmp();
    const { agent, db } = await startAgent({ dataDir, config: remote, responses: [f.fauxAssistantMessage('hi')] });
    try {
        const test = await call(agent, 'testRemoteBackup', { remoteHost: '127.0.0.1', remotePort: server.port });
        assert.match(test.result, /^OK: connected, the directory is writable/);

        const created = await call(agent, 'createBackup');
        assert.match(created.result, /copied to the external server \(\/backups\/pi-agent\/pi-agent-backup-/);
        const remoteName = [...disk.files.keys()].find(k => k.endsWith('.sqlite.gz'));
        assert.ok(remoteName, 'the file is on the server');
        assert.equal(db.states[`${NAMESPACE}.backup.remoteError`].val, '');

        const list = await call(agent, 'listRemoteBackups');
        assert.deepEqual(
            list.map(o => o.value),
            [path.posix.basename(remoteName)],
        );
        // a new installation: the local copy is gone, the one on the server is fetched
        agent.files = {};
        const restored = await call(agent, 'restoreFromRemote', { file: list[0].value });
        assert.match(restored.result, /is restored at the restart/);
        assert.ok(agent.files[`${STORAGE}/${BACKUP_DIR}/${list[0].value}`], 'fetched into the storage folder');
        assert.ok(fs.existsSync(path.join(dataDir, RESTORE_FILE)));
        await waitFor(async () => agent.restarted === 1, 'the restart');
    } finally {
        await stopAgent(agent);
        server.close();
    }
});

test('SFTP: a server with another host key is refused before the password is sent', async () => {
    const disk = { files: new Map(), directories: new Set() };
    const server = await startServer(disk);
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: {
            remoteEnabled: true,
            remoteHost: '127.0.0.1',
            remotePort: server.port,
            remoteUser: 'backup',
            remotePassword: 'secret',
            remoteDirectory: '/backups',
            remoteHostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        responses: [f.fauxAssistantMessage('hi')],
    });
    try {
        const created = await call(agent, 'createBackup');
        assert.match(
            created.result,
            /the copy to the external server FAILED: the host key of the server does not match/,
        );
        assert.match(db.states[`${NAMESPACE}.backup.remoteError`].val, /host key/);
        assert.equal(disk.files.size, 0);
        assert.ok(Object.keys(agent.files).length === 1, 'the local backup is kept');
    } finally {
        await stopAgent(agent);
        server.close();
    }
});
