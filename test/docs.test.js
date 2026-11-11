'use strict';

// 0.10.0: the documentation search on a RAG server (ioBrokerRAG, REST API v1): the client in lib/docs.js, the tool
// search_docs and the test button, through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docsSettings, docsProblem, splitContext, textsOfSources, searchDocs, testDocs } = require('../lib/docs');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-docs-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

/** An answer of POST /query as the API documents it: three results, the second from a GPL source. */
const QUERY_ANSWER = {
    context: [
        '[Source: ioBroker.docs/docs/en/adapterref/iobroker.javascript/javascript.md § schedule | doc | MIT | relevance: 0.81]\n### schedule\nschedule("0 7 * * *", ...)',
        '[Source: ioBroker.foo/README.md § Setup | doc | GPL-3.0 | relevance: 0.55]\n## Setup\nsecret text',
        '[Source: ioBroker.docs/docs/en/adapterref/iobroker.javascript/javascript.md § astro | doc | MIT | relevance: 0.74]\n### Astro\n---\nschedule({astro: "sunset"}, ...)',
    ].join('\n---\n'),
    sources: [
        { file: 'ioBroker.docs/docs/en/adapterref/iobroker.javascript/javascript.md', adapter: 'iobroker.javascript', section: 'schedule', relevance: 0.812, license: 'MIT', license_status: 'allow' },
        { file: 'ioBroker.foo/README.md', adapter: 'iobroker.foo', section: 'Setup', relevance: 0.55, license: 'GPL-3.0', license_status: 'review' },
        { file: 'ioBroker.docs/docs/en/adapterref/iobroker.javascript/javascript.md', adapter: 'iobroker.javascript', section: 'astro', relevance: 0.744, license: 'MIT', license_status: 'allow' },
    ],
    query_time_ms: 3051.2,
    total_results: 3,
};

/**
 * A fake RAG server.
 *
 * @param {{ token?: string }} [options] token the server wants
 * @returns {{ fetch: typeof fetch, calls: { url: string, init: RequestInit }[] }} fetch and the requests it got
 */
function fakeServer(options = {}) {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    /** @type {any} */
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const auth = Object(init.headers).Authorization;
        if (String(url).endsWith('/health')) {
            return reply(200, { status: 'ok', version: '0.4.0', api_version: 1, documents: 67660, built_at: '2026-11-05T19:09:48+0100' });
        }
        if (options.token && auth !== `Bearer ${options.token}`) {
            return reply(401, { detail: 'Unauthorized' });
        }
        if (String(url).endsWith('/stats')) {
            return reply(200, { total_documents: 67660, collections: {} });
        }
        if (String(url).endsWith('/query')) {
            return reply(200, QUERY_ANSWER);
        }
        return reply(404, { detail: 'Not Found' });
    };
    return { fetch: fetchImpl, calls };
}

test('docs: settings, a trailing slash and what is missing', () => {
    assert.deepEqual(docsSettings({ docsUrl: ' http://rag:8000/ ', docsToken: ' t ' }), { url: 'http://rag:8000', token: 't' });
    assert.match(docsProblem(docsSettings({})), /off/);
    assert.match(docsProblem(docsSettings({ docsUrl: 'rag:8000' })), /http:\/\//);
    assert.equal(docsProblem(docsSettings({ docsUrl: 'https://rag.example' })), '');
});

test('docs: the context splits into its results, a "---" inside a text does not split it', () => {
    const parts = splitContext(QUERY_ANSWER.context);
    assert.equal(parts.length, 3);
    assert.match(parts[2], /### Astro\n---\nschedule/);
});

test('docs: a search sends question, top_k and the token, and leaves out what is not permissively licensed', async () => {
    const server = fakeServer({ token: 'abc' });
    const found = await searchDocs(docsSettings({ docsUrl: 'http://rag:8000', docsToken: 'abc' }), ' schedule at sunset ', { topK: 50 }, server.fetch);
    const sent = JSON.parse(String(server.calls[0].init.body));
    assert.equal(server.calls[0].url, 'http://rag:8000/query');
    assert.deepEqual(sent, { question: 'schedule at sunset', top_k: 10, rerank: true });
    assert.equal(found.results.length, 2);
    assert.equal(found.left, 1);
    assert.ok(found.results.every(r => !r.text.includes('secret text')));
    assert.deepEqual(
        found.results.map(r => [r.adapter, r.section, r.relevance, r.license]),
        [
            ['iobroker.javascript', 'schedule', 0.81, 'MIT'],
            ['iobroker.javascript', 'astro', 0.74, 'MIT'],
        ],
    );
    assert.equal(found.ms, 3051);

    await assert.rejects(searchDocs(docsSettings({ docsUrl: 'http://rag:8000' }), 'x y', {}, server.fetch), /HTTP 401: the server wants a token/);
    await assert.rejects(searchDocs(docsSettings({}), 'schedule', {}, server.fetch), /off/);
});

test('docs: when texts and sources do not match, nothing is passed on', async () => {
    const odd = async () => new Response(JSON.stringify({ ...QUERY_ANSWER, context: 'one block without headers' }), { status: 200 });
    const found = await searchDocs(docsSettings({ docsUrl: 'http://rag:8000' }), 'schedule', {}, /** @type {any} */ (odd));
    assert.deepEqual(found.results, []);
    assert.equal(found.left, 1);
    assert.equal(found.unmatched, 2);
});

test('docs: empty lines around the separator still split the context', async () => {
    const parts = QUERY_ANSWER.context.split('\n---\n');
    const spaced = { ...QUERY_ANSWER, context: parts.join('\n\n---\n\n') };
    assert.equal(splitContext(spaced.context).length, 3);
    const answer = async () => new Response(JSON.stringify(spaced), { status: 200 });
    const found = await searchDocs(docsSettings({ docsUrl: 'http://rag:8000' }), 'schedule', {}, /** @type {any} */ (answer));
    assert.equal(found.results.length, 2);
    assert.ok(found.results.every(r => !r.text.endsWith('---')));
    assert.equal(found.unmatched, 0);
});

test('docs: with one text missing the others are matched by their file', () => {
    const sources = [{ file: 'a/x.md' }, { file: 'b/y.md' }, { file: 'c/z.md' }];
    const texts = ['[Source: a/x.md § s | doc | MIT | relevance: 0.8]\nA', '[Source: c/z.md | doc | MIT | relevance: 0.5]\nC'];
    assert.deepEqual(textsOfSources(sources, texts), [texts[0], undefined, texts[1]]);
});

test('docs: the test checks the server and the token', async () => {
    const server = fakeServer({ token: 'abc' });
    assert.match(await testDocs(docsSettings({ docsUrl: 'http://rag:8000', docsToken: 'abc' }), server.fetch), /^OK: ioBrokerRAG 0\.4\.0, 67660 chunks, index of 2026-11-05$/);
    await assert.rejects(testDocs(docsSettings({ docsUrl: 'http://rag:8000', docsToken: 'wrong' }), server.fetch), /401/);
});

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message = {}) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({ command, message, user: 'system.user.admin', from: 'system.adapter.admin.0', callback: { id: 1 } });
    });
}

test('search_docs: the model searches the documentation and gets the permissive passages', async () => {
    const f = await faux();
    const server = fakeServer();
    const { agent } = await startAgent({
        dataDir: tmp(),
        config: { docsUrl: 'http://rag:8000' },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('search_docs', { question: 'javascript adapter: schedule at sunset' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Use schedule({astro: "sunset"}).'),
        ],
    });
    agent.fetch = server.fetch;
    await call(agent, 'chatSend', { text: 'how do I run a script at sunset?' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    const history = await call(agent, 'chatHistory');
    const result = String(history.entries.findLast(e => e.detail?.name === 'search_docs')?.detail?.result ?? '');
    // the chat history shows the start of a result; the licence filter is checked on the client above
    assert.match(result, /^\{"results":\[\{"source":"ioBroker\.docs\/.*"adapter":"iobroker\.javascript","section":"schedule"/);
    assert.equal(server.calls.filter(c => c.url.endsWith('/query')).length, 1);

    // the test button of the settings takes the unsaved values of the form
    const answer = await call(agent, 'testDocs', { docsUrl: 'http://other:8000' });
    assert.match(String(answer.result), /^OK/);
    assert.ok(server.calls.some(c => c.url === 'http://other:8000/health'));
    await stopAgent(agent);
});
