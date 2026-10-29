'use strict';

// End-to-end through the real DeepSeek provider (OpenAI chat completions wire format) against a
// stand-in for api.deepseek.com, so no key and no network are needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIoBrokerExtension } = require('../lib/tools');
const { parseAllowlist } = require('../lib/guard');
const { createModelsWithKey } = require('../lib/providers');

const sse = chunks =>
	new Response(chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join(''), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});

const chunk = (delta, finish = null) => ({
	id: 'cmpl-1',
	object: 'chat.completion.chunk',
	created: 1,
	model: 'deepseek-flash',
	choices: [{ index: 0, delta, finish_reason: finish }],
});

test('DeepSeek: tool call reaches the ioBroker tool and the answer comes back', async () => {
	const requests = [];
	const replies = [
		sse([
			chunk({
				role: 'assistant',
				tool_calls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'get_state', arguments: '{"id":"hm-rpc.0.Wohnzimmer.Licht"}' },
					},
				],
			}),
			chunk({}, 'tool_calls'),
			'[DONE]',
		]),
		sse([chunk({ role: 'assistant', content: 'Das Licht ist aus.' }), chunk({}, 'stop'), '[DONE]']),
	];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return replies.shift() ?? new Response('no more replies', { status: 500 });
	};
	// The key must reach the provider through the credential store alone, not through the environment.
	delete process.env.DEEPSEEK_API_KEY;

	try {
		const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
		const durable = await import('@earendil-works/pi-durable');
		const { Type } = await import('@earendil-works/pi-ai');

		const adapter = {
			log: { info() {}, warn() {}, error() {} },
			getForeignStateAsync: async () => ({ val: false, ack: true, ts: 1, lc: 1 }),
		};
		const { spec, models } = await createModelsWithKey('deepseek', 'test-key');
		assert.equal(process.env.DEEPSEEK_API_KEY, undefined, 'the key must not be put into the environment');
		const registry = durable.createRegistry();
		registry.install(
			createIoBrokerExtension(adapter, { ...durable, Type }, () => ({
				allowlist: parseAllowlist(''),
				dryRun: true,
				instructions: '',
			})),
		);
		const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry }, context);
		const root = await harness.root(context, { agent: { model: { provider: 'deepseek', modelId: spec.defaultModel } } });
		const settled = await (await root.submit({ type: 'input', content: 'Ist das Licht an?' }, context)).wait(context);
		const view = await root.viewState(context);
		const kinds = view.value.entries.map(e => e.kind);
		const last = view.value.entries.filter(e => e.kind === 'pi.assistant').at(-1);
		view.dispose?.();
		await harness.close(context);

		assert.equal(settled.status, 'done', JSON.stringify(settled));
		assert.equal(requests.length, 2);
		assert.match(requests[0].url, /^https:\/\/api\.deepseek\.com\/.*chat\/completions$/);
		assert.equal(requests[0].headers.get('authorization'), 'Bearer test-key');
		assert.equal(requests[0].body.model, 'deepseek-flash');
		const toolNames = requests[0].body.tools.map(t => t.function.name).sort();
		assert.deepEqual(toolNames, ['find_states', 'forget', 'get_history', 'get_state', 'get_time', 'list_functions', 'list_instances', 'list_rooms', 'remember', 'remind_me', 'restart_instance', 'search_objects', 'send_to', 'set_state']);
		// The second request carries the tool result back to the model.
		const toolMsg = requests[1].body.messages.find(m => m.role === 'tool');
		assert.equal(toolMsg.tool_call_id, 'call_1');
		const toolText = typeof toolMsg.content === 'string' ? toolMsg.content : toolMsg.content.map(p => p.text).join('');
		assert.equal(JSON.parse(toolText).val, false);
		assert.ok(kinds.includes('pi.tool-result'));
		assert.match(JSON.stringify(last.model), /Das Licht ist aus/);
	} finally {
		globalThis.fetch = realFetch;
		delete process.env.DEEPSEEK_API_KEY;
	}
});
