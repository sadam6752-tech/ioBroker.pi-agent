'use strict';

// adapter_help: the description an adapter gives of its commands (message "help", common.supportedMessages.help),
// read without a write permission, and the mark "help" in list_instances.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIoBrokerExtension, acceptsMessages, helpText } = require('../lib/tools');
const { parseAllowlist } = require('../lib/guard');

const RECORDER_HELP = {
    help: 'ioBroker.recorder: records the states of the house.\nCommands (sendTo recorder.0):\n- getSnapshot {ts?}',
    commands: [
        { command: 'help', write: false },
        { command: 'getSnapshot', write: false },
        { command: 'ackAnomaly', write: true },
    ],
};

/** Instances: recorder.0 declares its help, telegram.0 answers messages without help, vis.0 takes none, sql.0 is stopped. */
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
        getForeignObjectAsync: async id => instances[id] ?? null,
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
    assert.deepEqual(rows, { 'recorder.0': true, 'sql.0': true, 'telegram.0': false, 'vis.0': false });
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
