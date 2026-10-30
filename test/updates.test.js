'use strict';

// 0.7.0: updates of adapters (list_updates, check_npm, update_adapter) through the real main.js, with the host
// command cmdExec answered like js-controller does (cmdStdout, cmdExit as messages to the instance).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { compareVersions, adapterNameOf, updateRefusal } = require('../lib/updates');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-070-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const adapterObj = (name, version) => ({ type: 'adapter', common: { name, version, title: name } });
const instanceObj = host => ({ type: 'instance', common: { host, enabled: true } });

/** Installed: telegram 1.0.0, zigbee 1.0.0 (on another host), admin 7.0.0, pi-agent 0.6.4; repository "stable". */
const SEED = () => ({
    objects: {
        'system.adapter.telegram': adapterObj('telegram', '1.0.0'),
        'system.adapter.telegram.0': instanceObj('iobroker'),
        'system.adapter.zigbee': adapterObj('zigbee', '1.0.0'),
        'system.adapter.zigbee.0': instanceObj('raspi'),
        'system.adapter.admin': adapterObj('admin', '7.0.0'),
        'system.adapter.admin.0': instanceObj('iobroker'),
        'system.adapter.pi-agent': adapterObj('pi-agent', '0.6.4'),
        'system.adapter.pi-agent.0': instanceObj('iobroker'),
        'system.repositories': {
            type: 'config',
            common: {},
            native: {
                repositories: {
                    stable: {
                        json: {
                            _repoInfo: { stable: true },
                            telegram: { version: '1.1.0' },
                            zigbee: { version: '2.0.0' },
                            admin: { version: '7.1.0' },
                            'pi-agent': { version: '0.6.4' },
                        },
                    },
                    beta: { json: { telegram: { version: '2.0.0-beta.1' } } },
                },
            },
        },
        'system.config': { type: 'config', common: { activeRepo: ['stable'] }, native: {} },
    },
    states: {},
});

const ALLOWED = {
    allowUpdates: true,
    writeRules: [
        { scope: 'telegram.0', write: true },
        { scope: 'zigbee.0', write: true },
    ],
};

/** The host: answers cmdExec with output and exit code; a successful upgrade sets the new version. */
function host(exitCode = 0) {
    return {
        sendToHost: (to, command, message, callback, agent) => {
            if (command !== 'cmdExec') {
                return;
            }
            setImmediate(async () => {
                const [, name, version] = /^(?:upgrade |url iobroker\.)([\w-]+)@(.+)$/.exec(message.data) || [];
                await agent.onMessage({
                    command: 'cmdStdout',
                    message: { id: message.id, data: `installing ${name}@${version}` },
                });
                if (exitCode === 0 && agent.db.objects[`system.adapter.${name}`]) {
                    agent.db.objects[`system.adapter.${name}`].common.version = version;
                }
                await agent.onMessage({ command: 'cmdExit', message: { id: message.id, data: exitCode } });
            });
        },
    };
}

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message = {}) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({
            command,
            message,
            user: 'system.user.admin',
            from: 'system.adapter.admin.0',
            callback: { id: 1 },
        });
    });
}

/** The result of the last call of a tool in the admin chat. */
async function lastResult(agent, tool) {
    const history = await call(agent, 'chatHistory');
    return String(history.entries.findLast(e => e.detail?.name === tool)?.detail?.result ?? '');
}

/** The full text of the tool results in the admin chat (the history of the page shortens them). */
async function toolResults(agent) {
    const conversation = await agent.harness.conversation(agent.chats['admin/system.user.admin'], agent.context);
    const view = await conversation.viewState(agent.context);
    const results = view.value.entries
        .filter(e => e.kind === 'pi.tool-result')
        .flatMap(e => e.model)
        .map(m => m.content.map(p => p.text).join(''));
    view.dispose?.();
    return results;
}

/** Ask in the admin chat; answer a confirmation question with "answer" when one comes. */
async function ask(agent, text, answer) {
    await call(agent, 'chatSend', { text });
    let question;
    await waitFor(async () => {
        const history = await call(agent, 'chatHistory');
        question = history.question;
        return question || !history.busy;
    }, 'a question or the answer');
    if (question && answer) {
        await call(agent, 'chatConfirm', { nonce: question.nonce, answer });
        await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    }
    return question;
}

const cmdExecs = agent =>
    (agent.hostMessages || []).filter(([, command]) => command === 'cmdExec').map(([to, , m]) => [to, m.data]);

test('versions, adapter names and the rules who may be updated', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0);
    assert.ok(compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.deepEqual(['iobroker.telegram', 'telegram.0', 'system.adapter.Telegram', ' telegram '].map(adapterNameOf), [
        'telegram',
        'telegram',
        'telegram',
        'telegram',
    ]);
    const rules = { enabled: true, own: 'pi-agent', isAllowed: i => i === 'telegram.0' };
    assert.equal(updateRefusal('telegram', { instances: ['telegram.0'] }, rules), '');
    assert.equal(updateRefusal('pi-agent', { instances: ['pi-agent.0'] }, rules), '');
    assert.match(
        updateRefusal('telegram', { instances: ['telegram.0'] }, { ...rules, enabled: false }),
        /switched off/,
    );
    assert.match(
        updateRefusal('admin', { instances: ['admin.0'] }, { ...rules, isAllowed: () => true }),
        /never updated/,
    );
    assert.match(updateRefusal('zigbee', { instances: ['zigbee.0'] }, rules), /Write allowed/);
});

test('list_updates: newer versions of the active repository, with whether the agent may update them', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: ALLOWED,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('list_updates', {}), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('ok'),
        ],
    });
    await ask(agent, 'are there updates?');
    const result = JSON.parse((await toolResults(agent)).at(-1));
    assert.deepEqual(result.repositories, ['stable']);
    const by = Object.fromEntries(result.updates.map(u => [u.adapter, u]));
    assert.deepEqual(
        Object.keys(by).sort(),
        ['admin', 'telegram', 'zigbee'],
        'pi-agent is current, beta is not active',
    );
    assert.deepEqual([by.telegram.installed, by.telegram.available, by.telegram.allowed], ['1.0.0', '1.1.0', true]);
    assert.match(by.admin.reason, /never updated/);
    assert.match(by.zigbee.reason, /another host/);
    await stopAgent(agent);
});

test('update_adapter: confirmed in the chat, then "upgrade" on the own host', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: { ...ALLOWED, dryRun: false },
        hooks: host(0),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('update_adapter', { adapter: 'telegram' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Updated.'),
        ],
    });
    const question = await ask(agent, 'update telegram', 'yes');
    assert.deepEqual(
        [question.action, question.id, question.val],
        ['update', 'telegram', '1.0.0 → 1.1.0 (repository)'],
    );
    assert.deepEqual(cmdExecs(agent), [['system.host.iobroker', 'upgrade telegram@1.1.0']]);
    const result = await lastResult(agent, 'update_adapter');
    assert.match(result, /telegram was updated from 1\.0\.0 to 1\.1\.0 \(repository\)/);
    assert.match(result, /installing telegram@1\.1\.0/);
    await stopAgent(agent);
});

test('update_adapter: "no" in the chat, a failing host command, and refusals start or report nothing wrong', async () => {
    const f = await faux();
    const run = async (config, args, answer, exitCode = 0) => {
        const { agent } = await startAgent({
            dataDir: tmp(),
            seed: SEED(),
            config: { dryRun: false, ...config },
            hooks: host(exitCode),
            responses: [
                f.fauxAssistantMessage(f.fauxToolCall('update_adapter', args), { stopReason: 'toolUse' }),
                f.fauxAssistantMessage('ok'),
            ],
        });
        await ask(agent, 'update', answer);
        const outcome = { result: await lastResult(agent, 'update_adapter'), execs: cmdExecs(agent) };
        await stopAgent(agent);
        return outcome;
    };
    let outcome = await run(ALLOWED, { adapter: 'telegram' }, 'no');
    assert.match(outcome.result, /did not confirm/);
    assert.deepEqual(outcome.execs, []);

    outcome = await run(ALLOWED, { adapter: 'telegram' }, 'yes', 1);
    assert.match(outcome.result, /failed \(exit code 1\)/);

    outcome = await run({ ...ALLOWED, allowUpdates: false }, { adapter: 'telegram' }, 'yes');
    assert.match(outcome.result, /switched off/);
    assert.deepEqual(outcome.execs, []);

    outcome = await run(ALLOWED, { adapter: 'admin' }, 'yes');
    assert.match(outcome.result, /never updated/);

    outcome = await run({ allowUpdates: true, writeRules: [] }, { adapter: 'telegram' }, 'yes');
    assert.match(outcome.result, /Write allowed/);

    outcome = await run(ALLOWED, { adapter: 'pi-agent' }, 'yes');
    assert.match(outcome.result, /no newer version \(0\.6\.4\); check_npm/);
    assert.deepEqual(outcome.execs, []);

    outcome = await run({ ...ALLOWED, dryRun: true }, { adapter: 'telegram' }, 'yes');
    assert.match(outcome.result, /DRY RUN - NOTHING WAS INSTALLED/);
    assert.deepEqual(outcome.execs, []);
});

test('check_npm and update_adapter from npm: "url" on the host, then the instances restart', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: { ...ALLOWED, dryRun: false },
        hooks: host(0),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('check_npm', { adapter: 'iobroker.telegram' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage(f.fauxToolCall('update_adapter', { adapter: 'telegram', source: 'npm' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Updated.'),
        ],
    });
    const urls = [];
    agent.fetch = async url => {
        urls.push(url);
        return { status: 200, ok: true, json: async () => ({ version: '1.2.0' }) };
    };
    const extended = [];
    const extend = agent.extendForeignObjectAsync.bind(agent);
    agent.extendForeignObjectAsync = async (id, obj) => {
        extended.push(id);
        return extend(id, obj);
    };
    const question = await ask(agent, 'update telegram from npm', 'yes');
    assert.deepEqual(JSON.parse((await toolResults(agent)).at(0)), {
        adapter: 'telegram',
        installed: '1.0.0',
        repository: '1.1.0',
        npm: '1.2.0',
        newer: true,
    });
    assert.ok(urls.every(u => u === 'https://registry.npmjs.org/iobroker.telegram/latest'));
    assert.equal(question.val, '1.0.0 → 1.2.0 (npm)');
    assert.deepEqual(cmdExecs(agent), [['system.host.iobroker', 'url iobroker.telegram@1.2.0']]);
    assert.deepEqual(extended, ['system.adapter.telegram.0']);
    assert.match(await lastResult(agent, 'update_adapter'), /updated from 1\.0\.0 to 1\.2\.0 \(npm\)/);
    await stopAgent(agent);
});

test('update of pi-agent itself: kept in update.pending, the next start reports it in the chat', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({
        dataDir,
        seed: SEED(),
        version: '0.6.4',
        config: { allowUpdates: true, dryRun: false },
        // the version of the adapter object stays: the new one is known only after the restart
        hooks: {
            sendToHost: (to, command, message, callback, agent) =>
                command === 'cmdExec' &&
                setImmediate(() => agent.onMessage({ command: 'cmdExit', message: { id: message.id, data: 0 } })),
        },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('update_adapter', { adapter: 'pi-agent', source: 'npm' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Restarting.'),
        ],
    });
    first.agent.fetch = async () => ({ status: 200, ok: true, json: async () => ({ version: '0.7.0' }) });
    await call(first.agent, 'chatSend', { text: 'update yourself' });
    let question;
    await waitFor(async () => (question = (await call(first.agent, 'chatHistory')).question), 'the question');
    await call(first.agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(first.agent, 'chatHistory')).busy, 'the answer');
    assert.deepEqual(cmdExecs(first.agent), [['system.host.iobroker', 'url iobroker.pi-agent@0.7.0']]);
    const pending = JSON.parse(first.db.states[`${NAMESPACE}.update.pending`].val);
    assert.deepEqual([pending.name, pending.from, pending.to, pending.source], ['pi-agent', '0.6.4', '0.7.0', 'npm']);
    await stopAgent(first.agent);

    const second = await startAgent({ dataDir, version: '0.7.0', config: { allowUpdates: true }, responses: [] });
    assert.equal(second.db.states[`${NAMESPACE}.update.pending`].val, '');
    assert.ok(second.agent.logs.some(([, m]) => /pi-agent was updated from 0\.6\.4 to 0\.7\.0/.test(m)));
    const notices = second.agent.adminChat.notices('system.user.admin').map(n => n.html);
    assert.ok(
        notices.some(n => n.includes('0.7.0')),
        JSON.stringify(notices),
    );
    await stopAgent(second.agent);
});

test('update_adapter is refused in a sendTo conversation: nobody there can confirm', async () => {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir: tmp(),
        seed: SEED(),
        config: { ...ALLOWED, dryRun: false },
        hooks: host(0),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('update_adapter', { adapter: 'telegram' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Not updated.'),
        ],
    });
    await agent.onMessage({
        command: 'ask',
        message: { text: 'update telegram' },
        from: 'javascript.0',
        callback: 'cb',
    });
    assert.deepEqual(cmdExecs(agent), []);
    assert.ok(
        agent.logs.some(([, m]) => /update_adapter .*confirmation: unavailable/.test(m)),
        JSON.stringify(agent.logs),
    );
    await stopAgent(agent);
});
