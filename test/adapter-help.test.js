'use strict';

// adapter_help: the description an adapter gives of its commands (message "help", common.supportedMessages.help),
// read without a write permission, and the mark "help" in list_instances.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIoBrokerExtension, acceptsMessages, helpText, describedStates, statesHelp } = require('../lib/tools');
const { parseAllowlist } = require('../lib/guard');

const RECORDER_HELP = {
    help: 'ioBroker.recorder: records the states of the house.\nCommands (sendTo recorder.0):\n- getSnapshot {ts?}',
    commands: [
        { command: 'help', write: false },
        { command: 'getSnapshot', write: false },
        { command: 'ackAnomaly', write: true },
    ],
};

/** A web-only adapter: no process, it is used through the states it describes in its io-package.json. */
const HOME3D_SHOW = {
    name: { en: 'Show in the 3D view' },
    desc: { en: 'Write a place or a device in words and every open 3D view flies there.', de: 'Einen Ort schreiben.' },
    type: 'string',
    role: 'text',
    write: true,
};

/**
 * Instances: recorder.0 declares its help, telegram.0 answers messages without help, vis.0 takes none, sql.0 is
 * stopped, home3d.0 takes none but describes its states.
 */
function fakeAdapter() {
    const instances = {
        'system.adapter.recorder.0': {
            type: 'instance',
            common: { title: 'Recorder', version: '0.2.0', mode: 'daemon', enabled: true, messagebox: true, supportedMessages: { custom: true, help: true } },
        },
        'system.adapter.telegram.0': {
            type: 'instance',
            common: { title: 'Telegram', version: '5.0.0', mode: 'daemon', enabled: true, supportedMessages: { custom: true, notifications: true } },
        },
        'system.adapter.vis.0': { type: 'instance', common: { title: 'Visualisation', version: '1.5.6', mode: 'once', enabled: true } },
        'system.adapter.sql.0': {
            type: 'instance',
            common: { title: 'SQL', version: '4.0.0', mode: 'daemon', enabled: false, messagebox: true, supportedMessages: { custom: true, help: true } },
        },
        'system.adapter.home3d.0': { type: 'instance', common: { title: '3D Home', version: '0.4.0', mode: 'once', enabled: true, onlyWWW: true } },
    };
    const others = {
        'system.adapter.home3d': {
            type: 'adapter',
            common: { name: 'home3d' },
            instanceObjects: [
                { _id: '', type: 'meta', common: { name: 'Files', type: 'meta.user' } },
                { _id: 'show', type: 'state', common: HOME3D_SHOW },
                { _id: 'places', type: 'state', common: { name: 'Places', desc: { en: 'JSON of the places.' }, type: 'string', role: 'json', write: false } },
                // no description: not part of the help
                { _id: 'other', type: 'state', common: { name: 'Other', type: 'number' } },
            ],
        },
        'system.adapter.vis': { type: 'adapter', common: { name: 'vis' }, instanceObjects: [] },
        'home3d.0.show': { type: 'state', common: HOME3D_SHOW },
        'home3d.0.places': { type: 'state', common: { name: 'Places', desc: { en: 'JSON of the places.' }, type: 'string', role: 'json', write: false } },
    };
    const alive = { 'system.adapter.recorder.0.alive': true, 'system.adapter.telegram.0.alive': true, 'system.adapter.sql.0.alive': false };
    const sent = [];
    const logs = [];
    return {
        namespace: 'pi-agent.0',
        sent,
        logs,
        log: {
            info: m => logs.push(m),
            warn: m => logs.push(m),
            error: m => logs.push(m),
        },
        getForeignObjectAsync: async id => instances[id] ?? others[id] ?? null,
        getForeignStateAsync: async id => (id in alive ? { val: alive[id], ack: true, ts: 1 } : null),
        getObjectViewAsync: async (design, search, params) => {
            assert.equal(`${design}/${search}`, 'system/instance');
            return {
                rows: Object.keys(instances)
                    .filter(id => id >= params.startkey && id <= params.endkey)
                    .map(id => ({ id, value: instances[id] })),
            };
        },
        sendToAsync: async (instance, command, message, options) => {
            sent.push([instance, command, message, options]);
            if (instance === 'recorder.0' && command === 'help') {
                return RECORDER_HELP;
            }
            // as many adapters do with a command they do not know
            return { error: `Unknown command: ${command}` };
        },
    };
}

async function setup() {
    const adapter = fakeAdapter();
    const durable = await import('@earendil-works/pi-durable');
    const schema = await import('@earendil-works/pi-schema');
    // nothing is allowed: adapter_help must work without any write permission
    const ext = createIoBrokerExtension(adapter, { ...durable, schema }, () => ({
        allowlist: parseAllowlist(''),
        dryRun: false,
        instructions: '',
    }));
    return { adapter, ext, durable };
}

/** Run one scripted model turn that calls a tool, return the tool-result text. */
async function callTool(ctx, name, args) {
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const faux = await import('@earendil-works/pi-ai/providers/faux');
    const { Harness, createRegistry, MemoryStorage } = ctx.durable;
    const provider = faux.fauxProvider();
    provider.setResponses([
        faux.fauxAssistantMessage(faux.fauxToolCall(name, args), { stopReason: 'toolUse' }),
        faux.fauxAssistantMessage(faux.fauxText('done')),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const registry = createRegistry();
    registry.install(ctx.ext);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: provider.provider.id, modelId: provider.getModel().id } } });
    const sub = await root.submit({ type: 'input', content: 'go' }, context);
    await sub.wait(context);
    const { entries } = await root.context(context);
    const entry = entries.find(e => e.kind === 'pi.tool-result');
    const out = JSON.parse(JSON.stringify(entry?.model ?? entry?.data));
    await harness.close(context);
    return JSON.stringify(out);
}

test('acceptsMessages decides like js-controller: supportedMessages wins over messagebox', () => {
    assert.equal(acceptsMessages({ messagebox: true }), true);
    assert.equal(acceptsMessages({}), false);
    assert.equal(acceptsMessages({ supportedMessages: { help: true } }), true);
    // midea: messagebox true, but every supported message false - js-controller delivers nothing
    assert.equal(acceptsMessages({ messagebox: true, supportedMessages: { custom: false, deviceManager: false } }), false);
});

test('helpText: the description and the commands split into reading and changing ones', () => {
    const out = helpText('recorder.0', RECORDER_HELP);
    assert.match(out, /^Help of recorder\.0:\nioBroker\.recorder: records/);
    assert.match(out, /Commands that only read: help, getSnapshot\n/);
    assert.match(out, /Commands that change something: ackAnomaly$/);
    // without a list only the text; a command without a write flag counts as changing
    assert.equal(helpText('a.0', { help: 'Text' }), 'Help of a.0:\nText');
    assert.match(helpText('a.0', { help: 'Text', commands: [{ command: 'x' }] }), /change something: x$/);
    assert.equal(helpText('a.0', { error: 'Unknown command: help' }), null);
    assert.equal(helpText('a.0', { help: '  ' }), null);
    assert.equal(helpText('a.0', 'help'), null);
    assert.match(helpText('a.0', { help: 'x'.repeat(30_000) }), /… \(cut\)$/);
});

test('list_instances marks the instances that describe their commands', async () => {
    const ctx = await setup();
    const out = await callTool(ctx, 'list_instances', {});
    // the rows as the model gets them (JSON text inside the result): instance -> whether it has "help": true
    const rows = Object.fromEntries(
        [...out.matchAll(/\{\\"instance\\":\\"([^\\]+)\\"[^}]*\}/g)].map(m => [m[1], m[0].includes('\\"help\\":true')]),
    );
    // home3d.0 takes no messages but describes its states
    assert.deepEqual(rows, { 'home3d.0': true, 'recorder.0': true, 'sql.0': true, 'telegram.0': false, 'vis.0': false });
});

test('adapter_help reads the help without any write permission', async () => {
    const ctx = await setup();
    const out = await callTool(ctx, 'adapter_help', { instance: 'system.adapter.Recorder.0' });
    assert.match(out, /Help of recorder\.0:/);
    assert.match(out, /Commands that change something: ackAnomaly/);
    assert.deepEqual(ctx.adapter.sent, [['recorder.0', 'help', {}, { timeout: 10_000 }]]);
    assert.ok(ctx.adapter.logs.some(l => /^Tool adapter_help .* -> \d+ characters$/.test(l)), ctx.adapter.logs.join('\n'));
});

test('adapter_help without a declared help asks briefly and does not let the model guess', async () => {
    const ctx = await setup();
    const out = await callTool(ctx, 'adapter_help', { instance: 'telegram.0' });
    assert.match(out, /telegram\.0 gives no description of its commands/);
    assert.match(out, /instead of guessing/);
    assert.deepEqual(ctx.adapter.sent, [['telegram.0', 'help', {}, { timeout: 3000 }]]);
});

test('adapter_help sends nothing to an instance that takes no messages, is stopped, is pi-agent or does not exist', async () => {
    const ctx = await setup();
    assert.match(await callTool(ctx, 'adapter_help', { instance: 'vis.0' }), /takes no commands/);
    assert.match(await callTool(ctx, 'adapter_help', { instance: 'sql.0' }), /sql\.0 is not running/);
    assert.match(await callTool(ctx, 'adapter_help', { instance: 'pi-agent.0' }), /pi-agent itself/);
    assert.match(await callTool(ctx, 'adapter_help', { instance: 'nothing.0' }), /There is no instance nothing\.0/);
    assert.match(await callTool(ctx, 'adapter_help', { instance: 'telegram' }), /is no adapter instance/);
    assert.deepEqual(ctx.adapter.sent, []);
});

test('send_to points to adapter_help and no longer asks to send "help" itself (that needs a write permission)', async () => {
    const { ext } = await setup();
    const sendTo = ext.tools.find(t => t.name === 'send_to');
    assert.ok(sendTo, 'send_to exists');
    assert.match(sendTo.description, /adapter_help/);
    assert.doesNotMatch(sendTo.description, /send it first/);
    assert.match(sendTo.description, /do not send "help" with send_to/);
});

test('describedStates: the states an adapter describes in its instanceObjects', () => {
    const adapterObj = {
        instanceObjects: [
            { _id: '', type: 'meta', common: { desc: 'the files' } },
            { _id: 'show', type: 'state', common: { desc: { en: 'Show it' } } },
            { _id: 'quiet', type: 'state', common: { desc: { en: '  ' } } },
            { _id: 'plain', type: 'state', common: { name: 'Plain' } },
            { _id: 'folder', type: 'channel', common: { desc: 'A folder' } },
        ],
    };
    assert.deepEqual(describedStates(adapterObj), ['show']);
    assert.deepEqual(describedStates(null), []);
    assert.deepEqual(describedStates({ instanceObjects: 'x' }), []);
});

test('statesHelp: each state with its type, whether it is writable, and its description', () => {
    const out = statesHelp('home3d.0', [
        { id: 'home3d.0.show', common: HOME3D_SHOW },
        { id: 'home3d.0.places', common: { desc: 'JSON', type: 'string', role: 'json', write: false } },
    ]);
    assert.match(out, /^Help of home3d\.0: it takes no commands/);
    assert.match(out, /\n- home3d\.0\.show \(string, text, writable\): Write a place or a device in words/);
    assert.match(out, /\n- home3d\.0\.places \(string, json, read-only\): JSON$/);
    assert.equal(statesHelp('a.0', [{ id: 'a.0.x', common: { type: 'number' } }]), null);
    assert.match(statesHelp('a.0', [{ id: 'a.0.x', common: { desc: 'x'.repeat(2000) } }]), /… \(cut\)$/);
});

test('adapter_help of an adapter without messages: the states it describes, no message sent', async () => {
    const ctx = await setup();
    const out = await callTool(ctx, 'adapter_help', { instance: 'home3d.0' });
    assert.match(out, /Help of home3d\.0: it takes no commands/);
    assert.match(out, /home3d\.0\.show \(string, text, writable\): Write a place or a device in words/);
    assert.match(out, /home3d\.0\.places \(string, json, read-only\)/);
    assert.doesNotMatch(out, /home3d\.0\.other/);
    assert.deepEqual(ctx.adapter.sent, []);
    assert.ok(ctx.adapter.logs.some(l => /^Tool adapter_help .* -> 2 states, \d+ characters$/.test(l)), ctx.adapter.logs.join('\n'));
});
