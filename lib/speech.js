'use strict';

/**
 * Speech recognition of voice messages over the transcription API of OpenAI
 * (POST <base>/audio/transcriptions, multipart with file and model, answer { text }).
 *
 * - "server": any server with that API, e.g. speaches (faster-whisper) or LocalAI in Docker; usually without a key.
 * - "openrouter": the speech models of OpenRouter (same API), with an OpenRouter key.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Model of OpenRouter when none is chosen: Whisper large-v3-turbo, a few cents per hour of speech. */
const DEFAULT_OPENROUTER_MODEL = 'openai/whisper-large-v3-turbo';

/** Telegram lets a bot download files up to 20 MB; anything larger is not a voice message. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** A local Whisper on a CPU needs about as long as the speech lasts; a long message gets enough time. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

/** Media types of the audio files a messenger delivers, by extension. */
const MEDIA_TYPES = {
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    webm: 'audio/webm',
    amr: 'audio/amr',
};

/**
 * The speech settings of a configuration (saved or unsaved form values).
 *
 * @param {{ speechService?: unknown, speechBaseUrl?: unknown, speechModel?: unknown, speechApiKey?: unknown, speechLanguage?: unknown }} config native configuration
 * @returns {{ service: '' | 'server' | 'openrouter', baseUrl: string, model: string, apiKey: string, language: string }} settings; service "" = off
 */
function speechSettings(config) {
    const service =
        config.speechService === 'server' || config.speechService === 'openrouter' ? config.speechService : '';
    const model = String(config.speechModel || '').trim();
    return {
        service,
        baseUrl:
            service === 'openrouter'
                ? OPENROUTER_BASE_URL
                : String(config.speechBaseUrl || '')
                      .trim()
                      .replace(/\/+$/, ''),
        model: model || (service === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : ''),
        apiKey: String(config.speechApiKey || '').trim(),
        // Whisper wants the bare ISO-639-1 code: "de-DE" -> "de"
        language: String(config.speechLanguage || '')
            .trim()
            .toLowerCase()
            .split(/[-_]/)[0],
    };
}

/**
 * What is missing before speech can be recognized, or "" when nothing is.
 *
 * @param {ReturnType<typeof speechSettings>} settings speech settings
 * @returns {string} reason
 */
function speechProblem(settings) {
    if (!settings.service) {
        return 'speech recognition is off';
    }
    if (settings.service === 'server' && !/^https?:\/\/\S+$/i.test(settings.baseUrl)) {
        return 'no server URL (e.g. http://192.168.1.10:8000/v1)';
    }
    if (!settings.model) {
        return 'no speech model chosen';
    }
    return '';
}

/**
 * The text of an error answer: speaches says { detail }, OpenAI and OpenRouter { error: { message } }.
 *
 * @param {Response} response failed response
 * @returns {Promise<string>} short reason
 */
async function errorText(response) {
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
        const body = JSON.parse(raw);
        detail = body?.error?.message || body?.detail || body?.message || raw;
    } catch {
        // not JSON: the raw text
    }
    return `HTTP ${response.status}${detail ? `: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`;
}

/**
 * Recognize the speech of an audio file.
 *
 * @param {ReturnType<typeof speechSettings>} settings speech settings with the key resolved
 * @param {Buffer} audio the file
 * @param {string} fileName its name; the extension tells the server the format
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<string>} the text, "" when nothing was recognized
 */
async function transcribe(settings, audio, fileName, fetchImpl = fetch) {
    const problem = speechProblem(settings);
    if (problem) {
        throw new Error(problem);
    }
    if (audio.length > MAX_AUDIO_BYTES) {
        throw new Error(`the audio file is too large (${Math.round(audio.length / 1048576)} MB)`);
    }
    const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: MEDIA_TYPES[ext] || 'application/octet-stream' }), fileName);
    form.append('model', settings.model);
    form.append('response_format', 'json');
    if (settings.language) {
        form.append('language', settings.language);
    }
    const response = await fetchImpl(`${settings.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(await errorText(response));
    }
    const body = Object(await response.json());
    return String(body.text ?? '').trim();
}

/**
 * The speech models to choose from: the transcription models of OpenRouter (public list, no key), or those a
 * server has installed (speaches marks them with task "automatic-speech-recognition").
 *
 * @param {ReturnType<typeof speechSettings>} settings speech settings with the key resolved
 * @param {typeof fetch} [fetchImpl] fetch, replaceable in tests
 * @returns {Promise<string[]>} model ids
 */
async function listSpeechModels(settings, fetchImpl = fetch) {
    if (!settings.service || !settings.baseUrl) {
        return [];
    }
    const url =
        settings.service === 'openrouter'
            ? `${OPENROUTER_BASE_URL}/models?output_modalities=transcription`
            : `${settings.baseUrl}/models`;
    const response = await fetchImpl(url, {
        headers: settings.apiKey && settings.service === 'server' ? { Authorization: `Bearer ${settings.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(await errorText(response));
    }
    const data = Object(await response.json()).data;
    return (Array.isArray(data) ? data : [])
        .filter(m => typeof m?.id === 'string' && m.id && (!m.task || m.task === 'automatic-speech-recognition'))
        .map(m => m.id);
}

/**
 * One second of silence as WAV (16 kHz, mono, 16 bit): the test of the settings sends it, so a wrong URL, key
 * or model shows up without a recording.
 *
 * @param {number} [ms] length
 * @returns {Buffer} WAV file
 */
function silenceWav(ms = 1000) {
    const rate = 16000;
    const data = Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

module.exports = {
    OPENROUTER_BASE_URL,
    DEFAULT_OPENROUTER_MODEL,
    MAX_AUDIO_BYTES,
    speechSettings,
    speechProblem,
    transcribe,
    listSpeechModels,
    silenceWav,
};
