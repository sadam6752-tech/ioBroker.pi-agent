'use strict';

// 0.10.3: a conversation whose answers are spoken (ioBroker.assistant sends `language`) reads temperatures,
// percentages and wind as whole numbers, so the model cannot read out "0,6 Grad"; other callers get the exact values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent } = require('./helpers/agent-harness');
const { spokenValue } = require('../lib/spoken-values');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-spoken-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const DAY = 'open-meteo-weather.0.Home.weather.forecast.day1';
const SEED = () => ({
    objects: {
        'system.config': { type: 'config', common: { language: 'de' }, native: {} },
        [`${DAY}.temperature_min`]: { type: 'state', common: { name: 'Min', type: 'number', unit: '°C' } },
        [`${DAY}.precipitation_probability`]: { type: 'state', common: { name: 'Rain', type: 'number', unit: '%' } },
        [`${DAY}.wind_speed`]: { type: 'state', common: { name: 'Wind', type: 'number', unit: 'km/h' } },
        [`${DAY}.precipitation`]: { type: 'state', common: { name: 'Rain sum', type: 'number', unit: 'mm' } },
    },
    states: {
        [`${DAY}.temperature_min`]: { val: 0.6, ack: true },
        [`${DAY}.precipitation_probability`]: { val: 84.6, ack: true },
        [`${DAY}.wind_speed`]: { val: 17.4, ack: true },
        [`${DAY}.precipitation`]: { val: 3.3, ack: true },
    },
});

test('spokenValue: whole numbers for temperatures, percentages and wind; everything else as it is', () => {
    assert.equal(spokenValue(0.6, '°C'), 1);
    assert.equal(spokenValue(2.8, ' °c '), 3);
    assert.equal(spokenValue(-0.4, '°C'), 0);
    assert.ok(!Object.is(spokenValue(-0.4, '°C'), -0), 'no "minus zero"');
    assert.equal(spokenValue(-3.5, '°C'), -3);
    assert.equal(spokenValue(84.6, '%'), 85);
    assert.equal(spokenValue(17.4, 'km/h'), 17);
    assert.equal(spokenValue(4.6, 'm/s'), 5);
    assert.equal(spokenValue(3.3, 'mm'), 3.3);
    assert.equal(spokenValue(0.6, ''), 0.6);
    assert.equal(spokenValue(0.6, undefined), 0.6);
    assert.equal(spokenValue('0.6', '°C'), '0.6', 'only numbers');
    assert.equal(spokenValue(true, '%'), true);
});

/**
 * Asks once with a tool call of get_state and returns what the model got back from the tool.
 *
 * @param {Record<string, unknown>} extra fields of the message besides text and conversation
 * @param {string} id state id or pattern
 */
async function toolResultFor(extra, id, config = {}) {
    const f = await faux();
    let toolResult = '';
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: { dryRun: false, ...config },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_state', { id }), { stopReason: 'toolUse' }),
            context => {
                toolResult = JSON.stringify(context.messages.at(-1));
                return f.fauxAssistantMessage('Ok.');
            },
        ],
    });
    await agent.onMessage({
        command: 'ask',
        message: { text: 'Wie wird das Wetter morgen?', conversation: 'kitchen', ...extra },
        from: 'system.adapter.assistant.0',
        callback: 'cb',
    });
    await stopAgent(agent);
    return toolResult;
}

test('a voice caller reads whole numbers: one state and a pattern', async () => {
    const one = await toolResultFor({ language: 'de' }, `${DAY}.temperature_min`);
    assert.match(one, /\\"val\\":1,/, one);
    const all = await toolResultFor({ language: 'de' }, `${DAY}.*`);
    for (const val of ['1', '85', '17', '3.3']) {
        assert.ok(all.includes(`\\"val\\":${val},`), `${val} in ${all}`);
    }
    assert.ok(!all.includes('0.6') && !all.includes('84.6') && !all.includes('17.4'), all);
});

test('a caller that does not speak the answers gets the exact values', async () => {
    const one = await toolResultFor({}, `${DAY}.temperature_min`);
    assert.match(one, /\\"val\\":0\.6,/, one);
});

test('the checkbox switched off: a voice caller gets the exact values too', async () => {
    const one = await toolResultFor({ language: 'de' }, `${DAY}.temperature_min`, { roundSpokenValues: false });
    assert.match(one, /\\"val\\":0\.6,/, one);
});
