'use strict';

// The list of the instances that describe themselves (lib/help-registry.js): read at the start, read again after a
// restart of an instance or a change of its object; an instance without a help leaves the list. With
// lib/adapter-knowledge.js the instructions tell a conversation which instances changed their help since it used them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHelpRegistry, FIRST_ASK_MS, SECOND_ASK_MS } = require('../lib/help-registry');
const { createAdapterKnowledge } = require('../lib/adapter-knowledge');
const { createIoBrokerExtension } = require('../lib/tools');
const { parseAllowlist } = require('../lib/guard');

const SHOW = { name: 'Show', desc: { en: 'Write a place and the 3D view flies there.' }, type: 'string', write: true };

/**
 * youtube-remote.0 and recorder.0 declare a help, telegram.0 does not, sql.0 is stopped, home3d.0 takes no messages
 * but describes a state, pi-agent.0 is the agent itself.
 */
function fakeAdapter() {
    const declared = { custom: true, help: true };
    const objects = {
        'system.adapter.youtube-remote.0': { type: 'instance', common: { enabled: true, supportedMessages: declared } },
        'system.adapter.recorder.0': { type: 'instance', common: { enabled: true, supportedMessages: declared } },
        'system.adapter.telegram.0': {
            type: 'instance',
            common: { enabled: true, supportedMessages: { custom: true } },
        },
        'system.adapter.sql.0': { type: 'instance', common: { enabled: false, supportedMessages: declared } },
        'system.adapter.home3d.0': { type: 'instance', common: { enabled: true, onlyWWW: true } },
        'system.adapter.pi-agent.0': { type: 'instance', common: { enabled: true, supportedMessages: declared } },
        'system.adapter.home3d': { type: 'adapter', instanceObjects: [{ _id: 'show', type: 'state', common: SHOW }] },
        'home3d.0.show': { type: 'state', common: SHOW },
        'youtube-remote.0.tv.title': { type: 'state', common: { type: 'string', role: 'media.title' } },
    };
    const states = {
        'system.adapter.youtube-remote.0.alive': { val: true },
        'system.adapter.recorder.0.alive': { val: true },
        'system.adapter.telegram.0.alive': { val: true },
        'system.adapter.sql.0.alive': { val: false },
        'system.adapter.pi-agent.0.alive': { val: true },
        'youtube-remote.0.tv.title': { val: 'Ep. 46', ack: true, ts: 1, lc: 1 },
    };
    const helps = {
        'youtube-remote.0': 'youtube: a video ID or a URL.',
        'recorder.0': 'getSnapshot {ts?}',
    };
    const sent = [];
    const logs = [];
    const timers = [];
    const adapter = {
        namespace: 'pi-agent.0',
        objects,
        states,
        helps,
        sent,
        logs,
        timers,
        /** instance -> Error: sendTo fails like a timeout */
        silent: new Map(),
        log: {
            info: m => logs.push(m),
            warn: m => logs.push(m),
            error: m => logs.push(m),
            debug: () => {},
        },
        getForeignObjectAsync: async id => (objects[id] ? JSON.parse(JSON.stringify(objects[id])) : null),
        getForeignStateAsync: async id => states[id] ?? null,
        getForeignStatesAsync: async pattern => {
            assert.equal(pattern, 'system.adapter.*.alive');
            return Object.fromEntries(Object.entries(states).filter(([id]) => /^system\.adapter\..*\.alive$/.test(id)));
        },
        getObjectViewAsync: async (design, search, params) => {
            assert.equal(`${design}/${search}`, 'system/instance');
            return {
                rows: Object.keys(objects)
                    .filter(id => objects[id].type === 'instance' && id >= params.startkey && id <= params.endkey)
                    .map(id => ({ id, value: objects[id] })),
            };
        },
        sendToAsync: async (instance, command) => {
            sent.push(`${instance} ${command}`);
            if (adapter.silent.has(instance)) {
                throw adapter.silent.get(instance);
            }
            return command === 'help' && helps[instance] ? { help: helps[instance] } : { error: 'unknown' };
        },
        setTimeout: (fn, ms) => {
            const timer = { fn, ms };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => {
            const at = timers.indexOf(timer);
            if (at >= 0) {
                timers.splice(at, 1);
            }
        },
    };
    return adapter;
}

/** Let the asks that were started finish (all fakes answer at once). */
const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * Fire the timers that are due.
 *
 * @param {ReturnType<typeof fakeAdapter>} adapter fake
 * @returns {Promise<number[]>} the delays of the timers fired
 */
async function fire(adapter) {
    const due = adapter.timers.splice(0);
    due.forEach(timer => timer.fn());
    await settle();
    return due.map(timer => timer.ms);
}

async function setup() {
    const adapter = fakeAdapter();
    const durable = await import('@earendil-works/pi-durable');
    const schema = await import('@earendil-works/pi-schema');
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const registry = createHelpRegistry(adapter);
    const knowledge = createAdapterKnowledge('');
    const ext = createIoBrokerExtension(adapter, { ...durable, schema }, () => ({
        allowlist: parseAllowlist(''),
        dryRun: false,
        instructions: 'Own instructions.',
        adapterKnowledge: knowledge,
        helpRegistry: registry,
    }));
    const section = ext.sections.find(s => s.key === 'iobroker');
    const tool = name => ext.tools.find(t => t.name === name);
    return {
        adapter,
        registry,
        instructions: conversationId => section.render({ conversationId }, context),
        call: (name, args, conversationId) => tool(name).execute(args, { conversationId }, context),
        /** the restart of an instance: alive false, then true */
        restart: id => {
            adapter.states[`system.adapter.${id}.alive`] = { val: false };
            registry.onAlive(`system.adapter.${id}.alive`, { val: false, ack: true, ts: 1, lc: 1, from: '', q: 0 });
            adapter.states[`system.adapter.${id}.alive`] = { val: true };
            registry.onAlive(`system.adapter.${id}.alive`, { val: true, ack: true, ts: 2, lc: 2, from: '', q: 0 });
        },
    };
}

test('at the start the helps of the running instances that describe themselves are read', async () => {
    const { adapter, registry, instructions } = await setup();
    assert.equal(await registry.start(), 3);
    assert.deepEqual([...registry.stamps().keys()].sort(), ['home3d.0', 'recorder.0', 'youtube-remote.0']);
    // telegram.0 declares no help, sql.0 is stopped, pi-agent.0 is the agent: none of them is asked
    assert.deepEqual(adapter.sent.sort(), ['recorder.0 help', 'youtube-remote.0 help']);

    const text = await instructions('c1');
    assert.match(
        text,
        /Instances that describe themselves \(call adapter_help for them\): home3d\.0, recorder\.0, youtube-remote\.0\./,
    );
    assert.match(text, /Before you first write the states of an instance that describes itself/);
    assert.match(text, /Before you tell the user that an adapter or a device cannot do something/);
    assert.match(text, /an earlier answer or error in this conversation is no proof/);
    assert.doesNotMatch(text, /UPDATED/);
    assert.match(text, /Own instructions\.$/, 'the instructions of the user stay last');
});

test('after a restart with a new help the conversations that used the instance are told until they read it', async () => {
    const { adapter, registry, instructions, call, restart } = await setup();
    await registry.start();
    // the voice conversation reads what plays on the TV
    await call('get_state', { id: 'youtube-remote.0.tv.title' }, 'voice');

    adapter.helps['youtube-remote.0'] = 'youtube: a video ID, a URL, a channel, @handle or words. Message search.';
    restart('youtube-remote.0');
    assert.deepEqual(await fire(adapter), [FIRST_ASK_MS], 'asked once, a little after the start');
    assert.ok(
        adapter.logs.includes(
            'The help of youtube-remote.0 changed: conversations that used it are told to read it again',
        ),
    );

    const text = await instructions('voice');
    assert.match(text, /UPDATED since this conversation last used them or read their help: youtube-remote\.0\./);
    assert.match(text, /may be wrong now\. Call adapter_help for them/);
    assert.doesNotMatch(await instructions('other'), /UPDATED/, 'a conversation that never used it is not told');

    const help = await call('adapter_help', { instance: 'youtube-remote.0' }, 'voice');
    assert.match(JSON.stringify(help), /Message search/);
    assert.doesNotMatch(await instructions('voice'), /UPDATED/);
});

test('a restart with the same help tells nobody, and the alive of every 15 s asks nothing', async () => {
    const { adapter, registry, instructions, call, restart } = await setup();
    await registry.start();
    await call('get_state', { id: 'youtube-remote.0.tv.title' }, 'voice');
    restart('youtube-remote.0');
    await fire(adapter);
    assert.doesNotMatch(await instructions('voice'), /UPDATED/);

    adapter.sent.length = 0;
    registry.onAlive('system.adapter.youtube-remote.0.alive', { val: true, ack: true, ts: 3, lc: 2, from: '', q: 0 });
    registry.onAlive('system.adapter.telegram.0.alive', { val: true, ack: true, ts: 3, lc: 2, from: '', q: 0 });
    assert.deepEqual(await fire(adapter), []);
    assert.deepEqual(adapter.sent, []);
});

test('an instance that no longer declares a help after its restart leaves the list', async () => {
    const { adapter, registry, instructions, restart } = await setup();
    await registry.start();
    adapter.objects['system.adapter.recorder.0'].common.supportedMessages = { custom: true };
    adapter.sent.length = 0;
    restart('recorder.0');
    await fire(adapter);
    assert.deepEqual(adapter.sent, [], 'it is not asked: it declares no help');
    assert.ok(!registry.stamps().has('recorder.0'));
    assert.ok(
        adapter.logs.includes(
            'recorder.0 no longer declares a help: removed from the instances that describe themselves',
        ),
    );
    assert.match(
        await instructions('c1'),
        /describe themselves \(call adapter_help for them\): home3d\.0, youtube-remote\.0\./,
    );
});

test('an instance that answers "help" without a help after its restart leaves the list', async () => {
    const { adapter, registry, restart } = await setup();
    await registry.start();
    delete adapter.helps['recorder.0'];
    restart('recorder.0');
    await fire(adapter);
    assert.ok(!registry.stamps().has('recorder.0'));
});

test('a deleted instance leaves the list at once; a switched off one after the check', async () => {
    const { adapter, registry } = await setup();
    await registry.start();
    delete adapter.objects['system.adapter.recorder.0'];
    registry.onObject('system.adapter.recorder.0', null);
    assert.ok(!registry.stamps().has('recorder.0'));
    assert.ok(adapter.logs.includes('recorder.0 was deleted: removed from the instances that describe themselves'));

    adapter.objects['system.adapter.youtube-remote.0'].common.enabled = false;
    adapter.states['system.adapter.youtube-remote.0.alive'] = { val: false };
    registry.onObject('system.adapter.youtube-remote.0', adapter.objects['system.adapter.youtube-remote.0']);
    await fire(adapter);
    assert.ok(!registry.stamps().has('youtube-remote.0'));
    assert.ok(
        adapter.logs.includes('youtube-remote.0 was switched off: removed from the instances that describe themselves'),
    );
});

test('an instance that is still starting is asked once more later and keeps its help meanwhile', async () => {
    const { adapter, registry, restart } = await setup();
    await registry.start();
    const before = registry.stamps().get('youtube-remote.0');
    adapter.silent.set('youtube-remote.0', new Error('timeout'));
    adapter.helps['youtube-remote.0'] = 'youtube: also words.';
    restart('youtube-remote.0');
    assert.deepEqual(await fire(adapter), [FIRST_ASK_MS]);
    assert.equal(registry.stamps().get('youtube-remote.0'), before, 'no answer: the old help stays');

    adapter.silent.delete('youtube-remote.0');
    assert.deepEqual(await fire(adapter), [SECOND_ASK_MS]);
    assert.notEqual(registry.stamps().get('youtube-remote.0'), before);
    assert.deepEqual(await fire(adapter), [], 'no third ask');
});

test('a stopped instance that is switched on is added when it comes up', async () => {
    const { adapter, registry, restart } = await setup();
    await registry.start();
    adapter.objects['system.adapter.sql.0'].common.enabled = true;
    adapter.helps['sql.0'] = 'query {sql}';
    restart('sql.0');
    await fire(adapter);
    assert.ok(registry.stamps().has('sql.0'));
});

test('a web-only adapter is read again when its object changes (it has no process to restart)', async () => {
    const { adapter, registry } = await setup();
    await registry.start();
    const before = registry.stamps().get('home3d.0');
    adapter.objects['home3d.0.show'].common = {
        ...SHOW,
        desc: { en: 'Write a place or a device and it flies there.' },
    };
    registry.onObject('system.adapter.home3d.0', adapter.objects['system.adapter.home3d.0']);
    await fire(adapter);
    assert.notEqual(registry.stamps().get('home3d.0'), before);
    // an instance that cannot describe itself is not asked when its object changes
    registry.onObject('system.adapter.telegram.0', adapter.objects['system.adapter.telegram.0']);
    assert.deepEqual(adapter.timers, []);
});

test('after stop nothing is asked any more', async () => {
    const { adapter, registry, restart } = await setup();
    await registry.start();
    adapter.sent.length = 0;
    restart('recorder.0');
    registry.stop();
    assert.deepEqual(adapter.timers, []);
    restart('youtube-remote.0');
    assert.deepEqual(await fire(adapter), []);
    assert.deepEqual(adapter.sent, []);
});

test('without the list (an older setup) the instructions render without the instances', async () => {
    const adapter = fakeAdapter();
    const durable = await import('@earendil-works/pi-durable');
    const schema = await import('@earendil-works/pi-schema');
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const ext = createIoBrokerExtension(adapter, { ...durable, schema }, () => ({
        allowlist: parseAllowlist(''),
        dryRun: false,
        instructions: '',
    }));
    const text = await ext.sections.find(s => s.key === 'iobroker').render({ conversationId: 'c1' }, context);
    assert.match(text, /You control an ioBroker smart home/);
    assert.doesNotMatch(text, /Instances that describe themselves|UPDATED/);
});
