'use strict';

/**
 * Search of the ioBroker documentation on a RAG server (ioBrokerRAG, REST API v1): POST <url>/query with
 * { question, top_k, rerank } answers the best chunks of the official documentation, the source code of the core and
 * the READMEs of the adapters, each with its source and licence. The agent uses it before it writes a script or answers
 * how an adapter works, so a model does not invent functions or settings.
 *
 * API: https://github.com/bloop-herbert-bot/ioBrokerRAG/blob/main/docs/api.md
 */

/** The search with the reranker needs about 3 s on a GPU, longer on a CPU. */
const QUERY_TIMEOUT_MS = 30_000;

/** Results per question: 5 is what the measurements of the project were made with. */
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;

/** At most this much text of the documentation goes to the model per search. */
const MAX_CONTEXT = 12_000;

/**
 * The settings of the documentation search of a configuration (saved or unsaved form values).
 *
 * @param {{ docsUrl?: unknown, docsToken?: unknown }} config native configuration
 * @returns {{ url: string, token: string }} settings; url "" = off
 */
function docsSettings(config) {
    return {
        url: String(config.docsUrl || '')
            .trim()
            .replace(/\/+$/, ''),
        token: String(config.docsToken || '').trim(),
    };
}

/**
 * What is missing before the documentation can be searched, or "" when nothing is.
 *
 * @param {ReturnType<typeof docsSettings>} settings settings
 * @returns {string} reason
 */
function docsProblem(settings) {
    if (!settings.url) {
        return 'the documentation search is off (no server URL)';
    }
    if (!/^https?:\/\/\S+$/i.test(settings.url)) {
        return 'the server URL must start with http:// or https:// (e.g. http://192.168.1.10:8000)';
    }
    return '';
}

/**
 * @param {ReturnType<typeof docsSettings>} settings settings
 * @returns {Record<string, string>} headers of a request
 */
function headers(settings) {
    return {
        'Content-Type': 'application/json',
        ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
    };
}

/**
 * The text of an error answer: FastAPI says { detail }.
 *
 * @param {Response} response failed response
 * @returns {Promise<string>} short reason
 */
async function errorText(response) {
    if (response.status === 401) {
        return 'HTTP 401: the server wants a token, or the token is wrong';
    }
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
        const body = JSON.parse(raw);
        detail = body?.detail ?? body?.error ?? raw;
    } catch {
        // not JSON: the raw text
    }
    const shown = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return `HTTP ${response.status}${shown ? `: ${shown.slice(0, 300)}` : ''}`;
}

/**
 * Splits the rendered context into its results: each starts with a "[Source: …]" header at the start of a line, and
 * the separator "---" between them (with or without empty lines around it) is removed. A "---" inside a text stays.
 *
 * @param {string} context rendered context of the answer
 * @returns {string[]} one text per result
 */
function splitContext(context) {
    return String(context || '')
        .split(/\r?\n(?=\[Source: )/)
        .map(part => part.replace(/(?:\s*\n)?\s*-{3,}\s*$/, '').trim())
        .filter(part => part.startsWith('[Source: '));
}

/**
 * The text of each source: by position when the numbers match, else by the file named in the header of a text.
 *
 * @param {Record<string, unknown>[]} sources sources of the answer
 * @param {string[]} texts texts of the context
 * @returns {(string | undefined)[]} text per source, undefined when none belongs to it
 */
function textsOfSources(sources, texts) {
    if (texts.length === sources.length) {
        return texts;
    }
    const free = [...texts];
    return sources.map(source => {
        const file = String(source.file || '');
        const index = file
            ? free.findIndex(text => text.startsWith(`[Source: ${file} `) || text.startsWith(`[Source: ${file}]`))
            : -1;
        return index < 0 ? undefined : free.splice(index, 1)[0];
    });
}

/**
 * Searches the documentation.
 *
 * Only results of permissively licensed sources (license_status "allow") go to the model; a server that also
 * indexes GPL sources ("review") marks them, and they are left out.
 *
 * @param {ReturnType<typeof docsSettings>} settings settings
 * @param {string} question question in natural language, German or English
 * @param {{ topK?: number, rerank?: boolean }} [options] number of results, reranker on (default) or off
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<{ results: { source: string, adapter: string, section: string, relevance: number, license: string, text: string }[], left: number, unmatched: number, ms: number }>}
 *     the results, best first; left = results left out for their licence, unmatched = results whose text was not found
 */
async function searchDocs(settings, question, options = {}, fetchImpl = fetch) {
    const problem = docsProblem(settings);
    if (problem) {
        throw new Error(problem);
    }
    const q = String(question || '').trim();
    if (q.length < 2) {
        throw new Error('the question is empty');
    }
    const topK = Math.min(MAX_TOP_K, Math.max(1, Math.round(Number(options.topK) || DEFAULT_TOP_K)));
    const response = await fetchImpl(`${settings.url}/query`, {
        method: 'POST',
        headers: headers(settings),
        body: JSON.stringify({ question: q.slice(0, 2000), top_k: topK, rerank: options.rerank !== false }),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(await errorText(response));
    }
    const body = Object(await response.json());
    const sources = Array.isArray(body.sources) ? body.sources : [];
    // a text without its source cannot be told by its licence, so it is not passed on
    const texts = textsOfSources(sources.map(Object), splitContext(body.context));
    const results = [];
    let left = 0;
    let unmatched = 0;
    let size = 0;
    sources.forEach((s, i) => {
        const source = Object(s);
        if (source.license_status !== 'allow') {
            left++;
            return;
        }
        if (texts[i] === undefined) {
            unmatched++;
            return;
        }
        const text = String(texts[i]).slice(0, Math.max(0, MAX_CONTEXT - size));
        size += text.length;
        if (!text) {
            return;
        }
        results.push({
            source: String(source.file || source.repo || ''),
            adapter: String(source.adapter || ''),
            section: String(source.section || ''),
            relevance: Math.round(Number(source.relevance || 0) * 100) / 100,
            license: String(source.license || ''),
            text,
        });
    });
    return { results, left, unmatched, ms: Math.round(Number(body.query_time_ms) || 0) };
}

/**
 * Checks the settings: the server answers (GET /health) and takes the token (GET /stats needs it when one is set).
 *
 * @param {ReturnType<typeof docsSettings>} settings settings
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<string>} what the server reported
 */
async function testDocs(settings, fetchImpl = fetch) {
    const problem = docsProblem(settings);
    if (problem) {
        throw new Error(problem);
    }
    const health = await fetchImpl(`${settings.url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) {
        throw new Error(await errorText(health));
    }
    const info = Object(await health.json());
    if (info.api_version !== undefined && Number(info.api_version) !== 1) {
        throw new Error(`the server speaks API version ${info.api_version}, pi-agent knows version 1`);
    }
    const stats = await fetchImpl(`${settings.url}/stats`, {
        headers: headers(settings),
        signal: AbortSignal.timeout(10_000),
    });
    if (!stats.ok) {
        throw new Error(await errorText(stats));
    }
    const built = info.built_at ? `, index of ${String(info.built_at).slice(0, 10)}` : '';
    return `OK: ioBrokerRAG ${info.version ?? '?'}, ${info.documents ?? '?'} chunks${built}`;
}

module.exports = {
    QUERY_TIMEOUT_MS,
    MAX_CONTEXT,
    docsSettings,
    docsProblem,
    splitContext,
    textsOfSources,
    searchDocs,
    testDocs,
};
