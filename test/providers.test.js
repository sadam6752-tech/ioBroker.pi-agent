'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
    PROVIDERS,
    loadProvider,
    listModels,
    normalizeBaseUrl,
    createModelsWithKey,
    testModel,
} = require('../lib/providers');

const CATALOG = Object.keys(PROVIDERS).filter(name => name !== 'custom');

for (const name of CATALOG) {
    test(`provider ${name}: loads, id matches, default model is in the catalog`, async () => {
        const { createModels } = await import('@earendil-works/pi-ai/models');
        const { spec, provider } = await loadProvider(name);
        assert.equal(provider.id, name);
        const models = createModels();
        models.setProvider(provider);
        const model = models.getModel(name, spec.defaultModel);
        assert.ok(
            model,
            `${spec.defaultModel} not found; known: ${models
                .getModels(name)
                .map(m => m.id)
                .join(', ')}`,
        );
    });
}

test('unknown provider is refused', async () => {
    await assert.rejects(loadProvider('nope'), /Unknown provider/);
});

test('openrouter: a model outside the catalog is added, a catalog model stays as it is', async () => {
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const lookup = async modelId => {
        const { provider } = await loadProvider('openrouter', { modelId });
        const models = createModels();
        models.setProvider(provider);
        return models.getModel('openrouter', modelId);
    };
    const extra = await lookup('vendor/brand-new-model');
    assert.equal(extra.provider, 'openrouter');
    assert.equal(extra.api, 'openai-completions');
    assert.equal(extra.baseUrl, 'https://openrouter.ai/api/v1');
    const known = await lookup(PROVIDERS.openrouter.defaultModel);
    assert.notEqual(known.name, known.id, 'the catalog entry with its own name is used');
    const { provider } = await loadProvider('openrouter', { modelId: PROVIDERS.openrouter.defaultModel });
    assert.equal(provider.getModels().filter(m => m.id === PROVIDERS.openrouter.defaultModel).length, 1);
});

test('listModels: default first, then unique catalog ids with readable labels', async () => {
    for (const name of CATALOG) {
        const options = await listModels(name);
        assert.equal(options[0].value, '');
        assert.equal(options[0].label, `Default (${PROVIDERS[name].defaultModel})`);
        const ids = options.slice(1).map(o => o.value);
        assert.ok(ids.length > 0, name);
        assert.equal(new Set(ids).size, ids.length, `${name}: ids unique`);
        assert.ok(ids.includes(PROVIDERS[name].defaultModel), `${name}: default model is in the list`);
    }
});

test('normalizeBaseUrl: trailing slashes go, only http and https', () => {
    assert.equal(normalizeBaseUrl(' http://localhost:8317/v1/ '), 'http://localhost:8317/v1');
    assert.equal(normalizeBaseUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1');
    assert.throws(() => normalizeBaseUrl(''), /empty/);
    assert.throws(() => normalizeBaseUrl('localhost:11434'), /http/);
    assert.throws(() => normalizeBaseUrl('ftp://host/v1'), /http/);
});

/**
 * OpenAI-compatible stand-in: /models lists two models, a chat completion streams "OK".
 *
 * @returns {Promise<{ baseUrl: string, requests: Array<{ url: string, auth?: string, body: any }>, close: () => void }>} server
 */
function fakeServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
            if (req.url === '/v1/models') {
                res.setHeader('content-type', 'application/json');
                res.end(
                    JSON.stringify({
                        object: 'list',
                        data: [{ id: 'qwen3:8b' }, { id: 'llama3.3' }, { id: 'qwen3:8b' }],
                    }),
                );
                return;
            }
            const chunk = (delta, finish) =>
                `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            res.setHeader('content-type', 'text/event-stream');
            res.write(chunk({ role: 'assistant', content: 'OK' }, null));
            res.write(chunk({}, 'stop'));
            res.end('data: [DONE]\n\n');
        });
    });
    return new Promise(resolve =>
        server.listen(0, '127.0.0.1', () =>
            resolve({
                baseUrl: `http://127.0.0.1:${Object(server.address()).port}/v1/`,
                requests,
                close: () => server.close(),
            }),
        ),
    );
}

test('custom provider: the model list comes from <base URL>/models, with the key when there is one', async () => {
    const server = await fakeServer();
    try {
        const options = await listModels('custom', { baseUrl: server.baseUrl, apiKey: 'secret' });
        assert.deepEqual(
            options.map(o => o.value),
            ['llama3.3', 'qwen3:8b'],
        );
        assert.equal(server.requests[0].auth, 'Bearer secret');
        await listModels('custom', { baseUrl: server.baseUrl });
        assert.equal(server.requests[1].auth, undefined);
    } finally {
        server.close();
    }
});

test('custom provider: a chat request goes to the base URL without fields compatible servers reject', async () => {
    const server = await fakeServer();
    try {
        const { models } = await createModelsWithKey('custom', '', { baseUrl: server.baseUrl, modelId: 'qwen3:8b' });
        assert.equal(await testModel(models, 'custom', 'qwen3:8b'), 'OK');
        const request = server.requests.at(-1);
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.auth, 'Bearer none', 'a server without a key still gets a header');
        assert.equal(request.body.model, 'qwen3:8b');
        assert.equal(request.body.store, undefined);
        assert.ok('max_tokens' in request.body);
        assert.ok(!request.body.messages.some(m => m.role === 'developer'));

        const keyed = await createModelsWithKey('custom', 'secret', { baseUrl: server.baseUrl, modelId: 'qwen3:8b' });
        await testModel(keyed.models, 'custom', 'qwen3:8b');
        assert.equal(server.requests.at(-1).auth, 'Bearer secret');
    } finally {
        server.close();
    }
});

test('custom provider: without a base URL it does not start', async () => {
    await assert.rejects(createModelsWithKey('custom', '', { modelId: 'x' }), /base URL/);
});

test('testModel: an unknown model and an unreachable server are errors', async () => {
    const { models } = await createModelsWithKey('custom', '', { baseUrl: 'http://127.0.0.1:9/v1', modelId: 'm' });
    await assert.rejects(testModel(models, 'custom', 'other'), /Unknown model/);
    await assert.rejects(testModel(models, 'custom', 'm'));
});
