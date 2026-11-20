'use strict';

// What a conversation knows of the adapters that describe themselves (lib/adapter-knowledge.js). Seen with
// youtube-remote: after an update that added a search, a voice conversation still answered "it takes only exact
// links" from its history, without calling a tool. The instructions now name the instances whose help changed since
// the conversation used them (test/help-registry.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapterKnowledge, instanceOfId, MAX_CONVERSATIONS } = require('../lib/adapter-knowledge');
const { helpStamp } = require('../lib/tools');

test('instanceOfId: the instance of a state id, a pattern or an instance object', () => {
    assert.equal(instanceOfId('youtube-remote.0.tv_8198d994.youtube'), 'youtube-remote.0');
    assert.equal(instanceOfId('youtube-remote.0.*'), 'youtube-remote.0');
    assert.equal(instanceOfId('recorder.0'), 'recorder.0');
    assert.equal(instanceOfId('system.adapter.recorder.0'), 'recorder.0');
    assert.equal(instanceOfId('0_userdata.0.lamp'), '0_userdata.0');
    assert.equal(instanceOfId('alias.0.lamp'), 'alias.0');
    assert.equal(instanceOfId('system.host.vitanova.cpu'), '');
    assert.equal(instanceOfId('*lamp*'), '');
    assert.equal(instanceOfId(undefined), '');
});

test('helpStamp changes with the help and only with it', () => {
    assert.equal(helpStamp('Help of a.0:\nplay'), helpStamp('Help of a.0:\nplay'));
    assert.notEqual(helpStamp('Help of a.0:\nplay'), helpStamp('Help of a.0:\nplay, search'));
    assert.match(helpStamp(''), /^[0-9a-f]{16}$/);
});

test('a use keeps the help the conversation first knew; only reading the help makes it current', () => {
    const knowledge = createAdapterKnowledge('');
    knowledge.used('c1', 'youtube-remote.0', 'A');
    const now = new Map([
        ['youtube-remote.0', 'B'],
        ['recorder.0', 'R'],
    ]);
    assert.deepEqual(knowledge.outdated('c1', now), ['youtube-remote.0']);
    // using it again after the update does not tell the conversation what changed
    knowledge.used('c1', 'youtube-remote.0', 'B');
    assert.deepEqual(knowledge.outdated('c1', now), ['youtube-remote.0']);
    knowledge.read('c1', 'youtube-remote.0', 'B');
    assert.deepEqual(knowledge.outdated('c1', now), []);
    // other conversations and instances that no longer describe themselves are not named
    assert.deepEqual(knowledge.outdated('c2', now), []);
    knowledge.used('c1', 'gone.0', 'G');
    assert.deepEqual(knowledge.outdated('c1', now), []);
    // no conversation (e.g. a check without one): nothing is noted
    knowledge.used(undefined, 'recorder.0', 'R');
    assert.deepEqual(knowledge.outdated(undefined, new Map([['recorder.0', 'X']])), []);
});

test('the knowledge survives a restart and keeps the conversations changed last', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-knowledge-'));
    const knowledge = createAdapterKnowledge(dir);
    knowledge.load();
    knowledge.used('voice', 'youtube-remote.0', 'A');
    const again = createAdapterKnowledge(dir);
    again.load();
    assert.deepEqual(again.outdated('voice', new Map([['youtube-remote.0', 'B']])), ['youtube-remote.0']);

    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
        again.used(`c${i}`, 'recorder.0', 'R');
    }
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'adapter-knowledge.json'), 'utf8'));
    assert.equal(Object.keys(kept).length, MAX_CONVERSATIONS);
    assert.ok(!('voice' in kept), 'the conversation changed least recently is dropped');
    assert.ok(`c${MAX_CONVERSATIONS + 4}` in kept);

    fs.writeFileSync(path.join(dir, 'adapter-knowledge.json'), 'not json');
    const broken = createAdapterKnowledge(dir);
    broken.load();
    assert.deepEqual(broken.outdated('c1', new Map([['recorder.0', 'X']])), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
