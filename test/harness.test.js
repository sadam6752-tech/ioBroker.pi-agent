'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIoBrokerExtension } = require('../lib/tools');
const { parseAllowlist } = require('../lib/guard');

const globToRegExp = pattern => new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);

/** Minimal stand-in for the adapter: three state objects (one read-only) and some values. */
function fakeAdapter() {
	const objects = {
		'hm-rpc.0.Wohnzimmer.Licht': { type: 'state', common: { name: 'Licht', type: 'boolean', write: true } },
		'hm-rpc.0.Haustuer.Schloss': { type: 'state', common: { name: 'Schloss', type: 'boolean', write: true } },
		'hm-rpc.0.Wohnzimmer.Temp': { type: 'state', common: { name: 'Temp', type: 'number', write: false } },
		'system.adapter.web.0.alive': { type: 'state', common: { name: 'web.0 alive', type: 'boolean', write: true } },
	};
	// 'system.adapter.vis.0.alive' has a value but no object, as seen on a real installation.
	const values = {
		'hm-rpc.0.Wohnzimmer.Licht': false,
		'system.adapter.vis.0.alive': false,
		'system.adapter.web.0.alive': true,
	};
	const writes = [];
	const logs = [];
	return {
		writes,
		logs,
		log: {
			info: m => logs.push(['info', m]),
			warn: m => logs.push(['warn', m]),
			error: m => logs.push(['error', m]),
		},
		// As observed on a real installation: a pattern that starts with "*" finds nothing here.
		getForeignObjectsAsync: async pattern => {
			if (pattern.startsWith('*')) {
				return {};
			}
			const re = globToRegExp(pattern);
			return Object.fromEntries(Object.entries(objects).filter(([id]) => re.test(id)));
		},
		getForeignObjectAsync: async id => objects[id] ?? null,
		getForeignStateAsync: async id => (id in values ? { val: values[id], ack: true, ts: 1, lc: 1 } : null),
		// Takes a list of ids (what the tools pass) and returns only those that have a value.
		getForeignStatesAsync: async ids => {
			assert.ok(Array.isArray(ids), 'tools must pass an id list, not a pattern');
			return Object.fromEntries(ids.filter(id => id in values).map(id => [id, { val: values[id], ack: true, ts: 1 }]));
		},
		getObjectViewAsync: async (design, search, params) => {
			if (`${design}/${search}` === 'system/instance') {
				return {
					rows: [
						{ id: 'system.adapter.vis.0', value: { common: { title: 'Visualisation', version: '1.5.6', mode: 'once', enabled: true } } },
						{ id: 'system.adapter.web.0', value: { common: { title: 'WEB server', version: '9.1.16', mode: 'daemon', enabled: true } } },
					],
				};
			}
			assert.equal(`${design}/${search}`, 'system/state');
			// Key range like CouchDB/js-controller: startkey <= id <= endkey.
			const rows = Object.keys(objects)
				.sort()
				.filter(id => id >= params.startkey && id <= params.endkey)
				.map(id => ({ id, value: objects[id] }));
			return { rows };
		},
		setForeignStateAsync: async (id, st) => {
			writes.push([id, st]);
			values[id] = st.val;
		},
	};
}

async function setup({ allow, dryRun }) {
	const adapter = fakeAdapter();
	const durable = await import('@earendil-works/pi-durable');
	const schema = await import('@earendil-works/pi-schema');
	const ext = createIoBrokerExtension(adapter, { ...durable, schema }, () => ({
		allowlist: parseAllowlist(allow),
		dryRun,
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
	const out = JSON.stringify(entry?.model ?? entry?.data);
	await harness.close(context);
	return out;
}

test('set_state on the allowlist is written with ack=false', async () => {
	const ctx = await setup({ allow: '^hm-rpc\\.0\\.Wohnzimmer\\.', dryRun: false });
	const out = await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Wohnzimmer.Licht', val: 'true' });
	assert.match(out, /Command sent/);
	assert.deepEqual(ctx.adapter.writes, [['hm-rpc.0.Wohnzimmer.Licht', { val: true, ack: false }]]);
});

test('set_state outside the allowlist is blocked before it runs', async () => {
	const ctx = await setup({ allow: '^hm-rpc\\.0\\.Wohnzimmer\\.', dryRun: false });
	const out = await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Haustuer.Schloss', val: false });
	assert.match(out, /not on the write allowlist/);
	assert.equal(ctx.adapter.writes.length, 0);
});

test('dry run answers but writes nothing', async () => {
	const ctx = await setup({ allow: '^hm-rpc\\.0\\.Wohnzimmer\\.', dryRun: true });
	const out = await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Wohnzimmer.Licht', val: true });
	assert.match(out, /DRY RUN - NOTHING WAS WRITTEN/);
	assert.equal(ctx.adapter.writes.length, 0);
});

test('read-only states are refused', async () => {
	const ctx = await setup({ allow: '.*', dryRun: false });
	const out = await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Wohnzimmer.Temp', val: 20 });
	assert.match(out, /read-only/);
	assert.equal(ctx.adapter.writes.length, 0);
});

test('search_objects finds states by pattern', async () => {
	const ctx = await setup({ allow: '', dryRun: true });
	const out = await callTool(ctx, 'search_objects', { pattern: 'hm-rpc.0.Wohnzimmer.*' });
	assert.match(out, /Wohnzimmer\.Licht/);
	assert.doesNotMatch(out, /Haustuer/);
});

test('get_state with a pattern reads matching values and logs the hit count', async () => {
	const ctx = await setup({ allow: '', dryRun: true });
	const out = await callTool(ctx, 'get_state', { id: 'system.adapter.*.alive' });
	assert.match(out, /system\.adapter\.web\.0\.alive/);
	// As on the real installation: the value of vis.0 has no object and is invisible to a pattern.
	assert.doesNotMatch(out, /vis\.0/);
	const lines = ctx.adapter.logs.map(([lvl, m]) => `${lvl} ${m}`);
	assert.ok(lines.includes('info Tool get_state {"id":"system.adapter.*.alive"} -> 1 states'), lines.join('\n'));
});

test('list_instances includes an instance whose alive state has no object (vis.0 case)', async () => {
	const ctx = await setup({ allow: '', dryRun: true });
	const out = await callTool(ctx, 'list_instances', {});
	assert.match(out, /\\"instance\\":\\"vis\.0\\"/);
	assert.match(out, /\\"mode\\":\\"once\\"/);
	assert.match(out, /\\"instance\\":\\"web\.0\\"/);
	const lines = ctx.adapter.logs.map(([lvl, m]) => `${lvl} ${m}`);
	assert.ok(lines.includes('info Tool list_instances {} -> 2 instances, 1 alive'), lines.join('\n'));
});

test('every tool call is logged with name, arguments and outcome', async () => {
	const ctx = await setup({ allow: '^hm-rpc\\.0\\.Wohnzimmer\\.', dryRun: true });
	await callTool(ctx, 'search_objects', { pattern: 'hm-rpc.0.*' });
	await callTool(ctx, 'get_state', { id: 'hm-rpc.0.Wohnzimmer.Licht' });
	await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Wohnzimmer.Licht', val: true });
	await callTool(ctx, 'set_state', { id: 'hm-rpc.0.Haustuer.Schloss', val: true });
	const lines = ctx.adapter.logs.map(([lvl, m]) => `${lvl} ${m}`);
	const expected = [
		'info Tool search_objects {"pattern":"hm-rpc.0.*"} -> 3 objects',
		'info Tool get_state {"id":"hm-rpc.0.Wohnzimmer.Licht"} -> val=false',
		'info Tool set_state {"id":"hm-rpc.0.Wohnzimmer.Licht","val":true} -> dry run, not written',
		'warn Tool set_state {"id":"hm-rpc.0.Haustuer.Schloss","val":true} -> blocked: not on the write allowlist',
	];
	for (const line of expected) {
		assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);
	}
});

test('search_objects with a leading "*" or a plain word finds states (testLamp case)', async () => {
	const ctx = await setup({ allow: '', dryRun: true });
	const star = await callTool(ctx, 'search_objects', { pattern: '*licht*' });
	assert.match(star, /hm-rpc\.0\.Wohnzimmer\.Licht/);
	const word = await callTool(ctx, 'search_objects', { pattern: 'Schloss' });
	assert.match(word, /hm-rpc\.0\.Haustuer\.Schloss/);
	assert.doesNotMatch(word, /Licht/);
	const lines = ctx.adapter.logs.map(([lvl, m]) => `${lvl} ${m}`);
	assert.ok(lines.includes('info Tool search_objects {"pattern":"*licht*"} -> 1 objects'), lines.join('\n'));
});
