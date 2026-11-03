'use strict';

// Speech recognition of voice messages (lib/speech.js): settings, the transcription request and its errors,
// the model list, and the silence of the settings test. fetch is a stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    speechSettings,
    speechProblem,
    transcribe,
    listSpeechModels,
    silenceWav,
    DEFAULT_OPENROUTER_MODEL,
    OPENROUTER_BASE_URL,
} = require('../lib/speech');

/** A fetch that records the requests and answers with the given status and body. */
function stubFetch(status, body) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(text, { status });
    };
    return { calls, fetchImpl };
}

test('speechSettings: off by default, a server URL without trailing slash, OpenRouter with its default model', () => {
    assert.equal(speechSettings({}).service, '');
    assert.equal(speechSettings({ speechService: 'whatever' }).service, '');
    const server = speechSettings({
        speechService: 'server',
        speechBaseUrl: ' http://nas:8000/v1/ ',
        speechModel: 'Systran/faster-whisper-small',
        speechLanguage: 'de-DE',
    });
    assert.deepEqual(server, {
        service: 'server',
        baseUrl: 'http://nas:8000/v1',
        model: 'Systran/faster-whisper-small',
        apiKey: '',
        language: 'de',
    });
    const openrouter = speechSettings({ speechService: 'openrouter', speechBaseUrl: 'http://ignored' });
    assert.equal(openrouter.baseUrl, OPENROUTER_BASE_URL);
    assert.equal(openrouter.model, DEFAULT_OPENROUTER_MODEL);
});

test('speechProblem names what is missing', () => {
    assert.match(speechProblem(speechSettings({})), /off/);
    assert.match(speechProblem(speechSettings({ speechService: 'server', speechModel: 'm' })), /no server URL/);
    assert.match(speechProblem(speechSettings({ speechService: 'server', speechBaseUrl: 'http://nas/v1' })), /model/);
    assert.equal(speechProblem(speechSettings({ speechService: 'openrouter' })), '');
});

test('transcribe posts the file, the model and the language, with the key as bearer token', async () => {
    const { calls, fetchImpl } = stubFetch(200, { text: '  Licht im Flur aus  ' });
    const settings = { ...speechSettings({ speechService: 'openrouter', speechLanguage: 'de' }), apiKey: 'sk-1' };
    const text = await transcribe(settings, Buffer.from('OggS fake'), 'voice.ogg', fetchImpl);
    assert.equal(text, 'Licht im Flur aus');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${OPENROUTER_BASE_URL}/audio/transcriptions`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer sk-1' });
    const form = calls[0].init.body;
    assert.equal(form.get('model'), DEFAULT_OPENROUTER_MODEL);
    assert.equal(form.get('language'), 'de');
    const file = form.get('file');
    assert.equal(file.name, 'voice.ogg');
    assert.equal(file.type, 'audio/ogg');
});

test('transcribe without key or language sends neither; an answer without text is ""', async () => {
    const { calls, fetchImpl } = stubFetch(200, {});
    const settings = speechSettings({ speechService: 'server', speechBaseUrl: 'http://nas/v1', speechModel: 'm' });
    assert.equal(await transcribe(settings, silenceWav(), 'test.wav', fetchImpl), '');
    assert.deepEqual(calls[0].init.headers, {});
    assert.equal(calls[0].init.body.get('language'), null);
    assert.equal(calls[0].init.body.get('file').type, 'audio/wav');
});

test('transcribe reports the reason of a server (detail) and of OpenRouter (error.message)', async () => {
    const settings = speechSettings({ speechService: 'server', speechBaseUrl: 'http://nas/v1', speechModel: 'x' });
    await assert.rejects(
        transcribe(settings, silenceWav(), 't.wav', stubFetch(404, { detail: "Model 'x' is not installed" }).fetchImpl),
        /HTTP 404: Model 'x' is not installed/,
    );
    await assert.rejects(
        transcribe(settings, silenceWav(), 't.wav', stubFetch(401, { error: { message: 'No auth' } }).fetchImpl),
        /HTTP 401: No auth/,
    );
    await assert.rejects(transcribe(speechSettings({}), silenceWav(), 't.wav', stubFetch(200, {}).fetchImpl), /off/);
    const big = Buffer.alloc(21 * 1024 * 1024);
    await assert.rejects(transcribe(settings, big, 'big.ogg', stubFetch(200, {}).fetchImpl), /too large/);
});

test('listSpeechModels: OpenRouter transcription models, a server only its speech-recognition models', async () => {
    const openrouter = stubFetch(200, { data: [{ id: 'openai/whisper-large-v3-turbo' }, { id: 'x/y' }] });
    assert.deepEqual(await listSpeechModels(speechSettings({ speechService: 'openrouter' }), openrouter.fetchImpl), [
        'openai/whisper-large-v3-turbo',
        'x/y',
    ]);
    assert.match(openrouter.calls[0].url, /output_modalities=transcription/);
    const server = stubFetch(200, {
        data: [
            { id: 'Systran/faster-whisper-small', task: 'automatic-speech-recognition' },
            { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', task: 'text-to-speech' },
            { id: 'plain-model' },
        ],
    });
    const settings = speechSettings({ speechService: 'server', speechBaseUrl: 'http://nas/v1' });
    assert.deepEqual(await listSpeechModels(settings, server.fetchImpl), ['Systran/faster-whisper-small', 'plain-model']);
    assert.equal(server.calls[0].url, 'http://nas/v1/models');
    assert.deepEqual(await listSpeechModels(speechSettings({}), server.fetchImpl), []);
});

test('silenceWav is a valid 16 kHz mono WAV of the given length', () => {
    const wav = silenceWav(500);
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
    assert.equal(wav.toString('latin1', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt32LE(40), 16000);
    assert.equal(wav.length, 44 + 16000);
});
