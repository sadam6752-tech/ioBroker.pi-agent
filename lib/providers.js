'use strict';

/**
 * Supported model providers. The key of this table is also the provider id pi-ai uses in model
 * references and in its credential store. "custom" is any server with the OpenAI chat completions
 * API at a base URL of the user (Ollama, LM Studio, vLLM, LiteLLM, Groq, OpenRouter, a local proxy).
 */
const PROVIDERS = {
    anthropic: {
        module: '@earendil-works/pi-ai/providers/anthropic',
        factory: 'anthropicProvider',
        defaultModel: 'claude-sonnet-5-5',
    },
    openai: {
        module: '@earendil-works/pi-ai/providers/openai',
        factory: 'openaiProvider',
        defaultModel: 'gpt-6-sol',
    },
    deepseek: {
        module: '@earendil-works/pi-ai/providers/deepseek',
        factory: 'deepseekProvider',
        defaultModel: 'deepseek-flash',
    },
    google: {
        module: '@earendil-works/pi-ai/providers/google',
        factory: 'googleProvider',
        defaultModel: 'gemini-3.5-flash',
    },
    openrouter: {
        module: '@earendil-works/pi-ai/providers/openrouter',
        factory: 'openrouterProvider',
        defaultModel: 'anthropic/claude-sonnet-5.5',
    },
    custom: {
        module: '',
        factory: '',
        defaultModel: '',
    },
};

/** Key sent to a custom server that needs none (Ollama, LM Studio); the OpenAI client always sends one. */
const NO_KEY = 'none';

/**
 * Base URL of a custom server without trailing slashes; only http and https.
 *
 * @param {unknown} value base URL from the configuration
 * @returns {string} normalized base URL
 */
function normalizeBaseUrl(value) {
    const url = String(value || '')
        .trim()
        .replace(/\/+$/, '');
    if (!url) {
        throw new Error('The base URL of the OpenAI-compatible server is empty');
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid base URL "${url}"`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Base URL "${url}" must start with http:// or https://`);
    }
    return url;
}

/**
 * Chat model of a custom server. Its real limits are unknown, so the values are conservative, and the
 * request avoids fields many compatible servers reject (store, developer role, max_completion_tokens).
 *
 * @param {string} id model id as the server knows it
 * @param {string} baseUrl base URL of the server
 * @returns {object} pi-ai chat model
 */
function customModel(id, baseUrl) {
    return {
        id,
        name: id,
        api: 'openai-completions',
        baseUrl,
        provider: 'custom',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        type: 'chat',
    };
}

/**
 * pi-ai provider for an OpenAI-compatible server; it knows the configured model only.
 *
 * @param {string} baseUrl base URL of the server
 * @param {string} modelId configured model id
 * @returns {Promise<object>} provider instance
 */
async function customProvider(baseUrl, modelId) {
    const [{ createProvider }, { openAICompletionsApi }] = await Promise.all([
        import('@earendil-works/pi-ai/models'),
        import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    ]);
    return createProvider({
        id: 'custom',
        name: 'OpenAI-compatible',
        baseUrl,
        auth: {
            apiKey: {
                name: 'API key of the OpenAI-compatible server',
                resolve: async ({ credential }) => ({
                    auth: { apiKey: credential?.key || NO_KEY },
                    source: credential?.key ? 'stored credential' : 'no key',
                }),
            },
        },
        models: modelId ? [customModel(modelId, baseUrl)] : [],
        api: openAICompletionsApi(),
    });
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter chat model that the pi-ai catalog does not list yet. OpenRouter adds models faster than pi-ai
 * releases, so such a model is used through the OpenAI API of OpenRouter. With its entry of the public model list
 * of OpenRouter it gets its prices, context window, answer length and image input; without it conservative limits
 * and no cost. Reasoning stays off: how a model wants it sent back differs from model to model.
 *
 * @param {string} id model id as OpenRouter knows it, e.g. "minimax/minimax-m3.1-flash"
 * @param {{ name?: string, context_length?: number, architecture?: { input_modalities?: string[] }, pricing?: unknown, top_provider?: { context_length?: number, max_completion_tokens?: number } }} [entry]
 *   the model's entry of GET /models of OpenRouter
 * @param {(pricing: unknown) => object} [toCost] prices per token of OpenRouter to the cost of pi-ai (per million)
 * @returns {object} pi-ai chat model
 */
function openrouterModel(id, entry, toCost) {
    const top = entry?.top_provider || {};
    return {
        id,
        name: typeof entry?.name === 'string' && entry.name ? entry.name : id,
        api: 'openai-completions',
        baseUrl: OPENROUTER_BASE_URL,
        provider: 'openrouter',
        reasoning: false,
        input: entry?.architecture?.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
        cost: entry?.pricing && toCost ? toCost(entry.pricing) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(top.context_length || entry?.context_length) || 128000,
        maxTokens: Number(top.max_completion_tokens) || 8192,
        compat: { supportsDeveloperRole: false, supportsStrictMode: true },
        type: 'chat',
    };
}

/**
 * The entry of one model in the public model list of OpenRouter (GET /models, no key needed).
 *
 * @param {string} id model id
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<object | undefined>} the entry, undefined when the list has no such model
 */
async function fetchOpenRouterEntry(id, fetchImpl = fetch) {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL}/models`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
        throw new Error(`OpenRouter answered ${response.status} ${response.statusText} for /models`);
    }
    const body = Object(await response.json());
    return (Array.isArray(body.data) ? body.data : []).find(m => Object(m).id === id);
}

/**
 * The provider with one more chat model, for a configured model that its catalog does not list.
 *
 * @param {{ getModels: () => object[], getAllModels?: () => object[] }} provider pi-ai provider instance
 * @param {object} model the extra model
 * @returns {object} provider instance that also lists the model
 */
function withModel(provider, model) {
    return {
        ...provider,
        getModels: () => [...provider.getModels(), model],
        getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), model],
    };
}

/**
 * Load the pi-ai provider for a configured name.
 *
 * @param {string} name provider name from the configuration
 * @param {{ baseUrl?: string, modelId?: string, fetch?: typeof fetch, log?: { warn: (msg: string) => void } }} [options]
 *   base URL of a custom server, the configured model; fetch and log for a model OpenRouter's catalog lacks
 * @returns {Promise<{ spec: typeof PROVIDERS[keyof typeof PROVIDERS], provider: object }>} spec and provider instance
 */
async function loadProvider(name, options = {}) {
    const spec = PROVIDERS[name];
    if (!spec) {
        throw new Error(`Unknown provider "${name}"`);
    }
    const modelId = String(options.modelId || '').trim();
    if (name === 'custom') {
        return { spec, provider: await customProvider(normalizeBaseUrl(options.baseUrl), modelId) };
    }
    const mod = await import(spec.module);
    const provider = mod[spec.factory]();
    if (name === 'openrouter' && modelId && !provider.getModels().some(m => m.id === modelId)) {
        let entry;
        try {
            entry = await fetchOpenRouterEntry(modelId, options.fetch);
            if (!entry) {
                options.log?.warn(`OpenRouter does not list the model ${modelId}; it is used without prices`);
            }
        } catch (e) {
            options.log?.warn(`No prices for ${modelId}: ${e.message}`);
        }
        const { openRouterCost } = await import('@earendil-works/pi-ai/providers/openrouter-api');
        return { spec, provider: withModel(provider, openrouterModel(modelId, entry, openRouterCost)) };
    }
    return { spec, provider };
}

/**
 * Model collection for one provider whose API key lives in an in-memory credential store.
 * A stored credential takes precedence over environment variables in pi-ai, so the key never
 * has to be put into the environment of the (possibly shared) process.
 *
 * @param {string} name provider name from the configuration
 * @param {string} apiKey API key of that provider (may be empty for a custom server)
 * @param {{ baseUrl?: string, modelId?: string, fetch?: typeof fetch, log?: { warn: (msg: string) => void } }} [options] as for loadProvider
 * @returns {Promise<{ spec: typeof PROVIDERS[keyof typeof PROVIDERS], models: object }>} spec and models
 */
async function createModelsWithKey(name, apiKey, options = {}) {
    const { spec, provider } = await loadProvider(name, options);
    const [{ createModels }, { InMemoryCredentialStore }] = await Promise.all([
        import('@earendil-works/pi-ai/models'),
        import('@earendil-works/pi-ai'),
    ]);
    const credentials = new InMemoryCredentialStore();
    if (apiKey) {
        await credentials.modify(name, async () => ({ type: 'api_key', key: apiKey }));
    }
    const models = createModels({ credentials });
    models.setProvider(provider);
    return { spec, models };
}

/**
 * Model ids a custom server offers (GET <base URL>/models).
 *
 * @param {string} baseUrl base URL of the server
 * @param {string} apiKey API key, may be empty
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<string[]>} sorted model ids
 */
async function fetchCustomModels(baseUrl, apiKey, fetchImpl = fetch) {
    const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        throw new Error(`The server answered ${response.status} ${response.statusText} for /models`);
    }
    const body = Object(await response.json());
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const ids = list.map(m => String(Object(m).id || Object(m).name || '')).filter(Boolean);
    return [...new Set(ids)].sort();
}

/**
 * Choices for the model field of the admin page: "default", then the catalog models of the provider.
 * The catalog comes with the installed pi-ai version, so it lists exactly what this adapter can use;
 * a model that is not listed can still be typed in. A custom server is asked for its models.
 *
 * @param {string} name provider name
 * @param {{ baseUrl?: string, apiKey?: string, fetch?: typeof fetch }} [options] server and key of a custom provider
 * @returns {Promise<Array<{ value: string, label: string, noTranslation: boolean }>>} options for autocompleteSendTo
 */
async function listModels(name, options = {}) {
    if (name === 'custom') {
        const ids = await fetchCustomModels(String(options.baseUrl || ''), options.apiKey || '', options.fetch);
        return ids.map(id => ({ value: id, label: id, noTranslation: true }));
    }
    const { spec, provider } = await loadProvider(name);
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const models = createModels();
    models.setProvider(provider);
    const list = models.getModels(name).map(m => ({
        value: m.id,
        label: m.name && m.name !== m.id ? `${m.id} - ${m.name}` : m.id,
        noTranslation: true,
    }));
    return [{ value: '', label: `Default (${spec.defaultModel})`, noTranslation: true }, ...list];
}

/**
 * Ask the model one short question, for the button "Test connection" of the admin page.
 *
 * @param {object} models model collection from createModelsWithKey
 * @param {string} name provider name
 * @param {string} modelId model id
 * @returns {Promise<string>} the answer of the model
 */
async function testModel(models, name, modelId) {
    const model = models.getModel(name, modelId);
    if (!model) {
        throw new Error(`Unknown model "${modelId}" of provider ${name}`);
    }
    const answer = await models.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }] },
        { maxTokens: 64, signal: AbortSignal.timeout(30000) },
    );
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
        throw new Error(answer.errorMessage || 'The model returned an error');
    }
    const text = (Array.isArray(answer.content) ? answer.content : [])
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ')
        .trim();
    return text || '(empty answer)';
}

module.exports = {
    PROVIDERS,
    normalizeBaseUrl,
    customModel,
    openrouterModel,
    fetchOpenRouterEntry,
    loadProvider,
    createModelsWithKey,
    fetchCustomModels,
    listModels,
    testModel,
};
