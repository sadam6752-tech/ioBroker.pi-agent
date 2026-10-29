'use strict';

// 0.6.2: rooms and functions (list_rooms, list_functions, find_states) and the details of a state (min, max, allowed
// values), through the real main.js and the tools as the model calls them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-rooms-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const state = (name, common = {}) => ({ type: 'state', common: { name, type: 'boolean', role: 'switch', read: true, write: true, ...common } });

/** A small house: kitchen and living room, lights and heating; a device whose states lie below it. */
const HOUSE = {
    objects: {
        'enum.rooms.kitchen': { type: 'enum', common: { name: { en: 'Kitchen', de: 'Küche', ru: 'Кухня' }, members: ['hue.0.kitchen', 'hm-rpc.0.ABC.4'] } },
        'enum.rooms.living': { type: 'enum', common: { name: { en: 'Living room', de: 'Wohnzimmer' }, members: ['hue.0.living.on', 'hm-rpc.0.XYZ.1'] } },
        'enum.functions.light': { type: 'enum', common: { name: { en: 'Light', de: 'Licht' }, members: ['hue.0.kitchen', 'hue.0.living.on'] } },
        'enum.functions.heating': { type: 'enum', common: { name: { en: 'Heating', de: 'Heizung' }, members: ['hm-rpc.0.ABC.4', 'hm-rpc.0.XYZ.1'] } },
        'hue.0.kitchen.on': state('Kitchen light'),
        'hue.0.kitchen.level': state('Kitchen brightness', { type: 'number', role: 'level.dimmer', min: 0, max: 100, unit: '%' }),
        'hue.0.living.on': state('Living room light'),
        'hm-rpc.0.ABC.4.SET_TEMPERATURE': state('Kitchen thermostat', { type: 'number', role: 'level.temperature', min: 5, max: 30, unit: '°C' }),
        'hm-rpc.0.ABC.4.MODE': state('Kitchen thermostat mode', { type: 'number', role: 'state', states: { 0: 'Auto', 1: 'Manu', 2: 'Party' } }),
        'hm-rpc.0.XYZ.1.SET_TEMPERATURE': state('Living room thermostat', { type: 'number', role: 'level.temperature', min: 5, max: 30 }),
    },
    states: { 'hm-rpc.0.ABC.4.MODE': { val: 0, ack: true, ts: 1 } },
};

/** Call one tool through a faux model turn and return what the tool answered. */
async function toolResult(name, args) {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: structuredClone(HOUSE),
        responses: [f.fauxAssistantMessage(f.fauxToolCall(name, args), { stopReason: 'toolUse' }), f.fauxAssistantMessage('ok')],
    });
    const call = (command, message = {}) =>
        new Promise(resolve => {
            const sendTo = agent.sendTo.bind(agent);
            agent.sendTo = (to, cmd, answer) => {
                agent.sendTo = sendTo;
                resolve(answer);
            };
            agent.onMessage({ command, message, user: 'system.user.admin', from: 'system.adapter.admin.0', callback: { id: 1 } });
        });
    await call('chatSend', { text: 'go' });
    await waitFor(async () => !(await call('chatHistory')).busy, 'the answer');
    // the page shows the start of a result; the log line of the tool names the outcome
    const conversation = await agent.harness.conversation(agent.chats['admin/system.user.admin'], agent.context);
    const view = await conversation.viewState(agent.context);
    const result = view.value.entries
        .filter(e => e.kind === 'pi.tool-result')
        .flatMap(e => e.model)
        .map(m => m.content.map(p => p.text).join(''))
        .at(-1);
    view.dispose?.();
    await stopAgent(agent);
    return JSON.parse(result);
}

test('list_rooms and list_functions: names in English, members counted', async () => {
    assert.deepEqual(await toolResult('list_rooms', {}), {
        total: 2,
        rows: [
            { id: 'enum.rooms.kitchen', name: 'Kitchen', members: 2 },
            { id: 'enum.rooms.living', name: 'Living room', members: 2 },
        ],
    });
    assert.equal((await toolResult('list_functions', {})).total, 2);
});

test('find_states: room and function together, names in any language; devices bring the states below them', async () => {
    const lights = await toolResult('find_states', { room: 'кухня', function: 'Licht' });
    assert.deepEqual(lights.matched, ['enum.rooms.kitchen', 'enum.functions.light']);
    assert.deepEqual(
        lights.rows.map(r => r.id),
        ['hue.0.kitchen.level', 'hue.0.kitchen.on'],
    );
    const level = lights.rows.find(r => r.id === 'hue.0.kitchen.level');
    assert.deepEqual([level.min, level.max, level.unit], [0, 100, '%']);

    const heating = await toolResult('find_states', { function: 'heizung' });
    assert.deepEqual(
        heating.rows.map(r => r.id),
        ['hm-rpc.0.ABC.4.MODE', 'hm-rpc.0.ABC.4.SET_TEMPERATURE', 'hm-rpc.0.XYZ.1.SET_TEMPERATURE'],
    );
    assert.deepEqual(heating.rows[0].states, { 0: 'Auto', 1: 'Manu', 2: 'Party' });

    const living = await toolResult('find_states', { room: 'Wohn' });
    assert.deepEqual(
        living.rows.map(r => r.id),
        ['hm-rpc.0.XYZ.1.SET_TEMPERATURE', 'hue.0.living.on'],
    );
});

test('find_states: an unknown room names the known ones', async () => {
    const result = await toolResult('find_states', { room: 'Garage' });
    assert.equal(result.error, 'No room named "Garage"');
    assert.deepEqual(result['known rooms'], ['Kitchen', 'Living room']);
});

test('search_objects and get_state: min, max and the allowed values', async () => {
    const found = await toolResult('search_objects', { pattern: 'hm-rpc.0.ABC.4.*' });
    const mode = found.rows.find(r => r.id === 'hm-rpc.0.ABC.4.MODE');
    assert.deepEqual(mode.states, { 0: 'Auto', 1: 'Manu', 2: 'Party' });
    const temp = found.rows.find(r => r.id === 'hm-rpc.0.ABC.4.SET_TEMPERATURE');
    assert.deepEqual([temp.min, temp.max, temp.unit], [5, 30, '°C']);

    const value = await toolResult('get_state', { id: 'hm-rpc.0.ABC.4.MODE' });
    assert.equal(value.val, 0);
    assert.equal(value.type, 'number');
    assert.deepEqual(value.states, { 0: 'Auto', 1: 'Manu', 2: 'Party' });
    assert.equal(value.id, undefined, 'no repeated id or name');
});
