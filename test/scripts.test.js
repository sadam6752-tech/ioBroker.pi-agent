'use strict';

// 0.8.0: scripts of the javascript adapter, created and changed by the agent: the scope, the confirmations (admin
// chat with the diff, voice only with its own setting), the syntax check, start, stop and revert, through the real
// main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');
const {
    scriptIdOf,
    lineDiff,
    scriptWarnings,
    syntaxError,
    scriptQuestion,
    createScriptHistory,
} = require('../lib/scripts');
const { confirmationQuestion } = require('../lib/text-confirmation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-scripts-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

const OWN = 'script.js.pi-agent.Evening_light';
const FOREIGN = 'script.js.heating.boiler';
const SOURCE = "schedule('0 20 * * *', () => {\n    setState('hm-rpc.0.ABC.1.STATE', true);\n});";
const script = (source, extra = {}) => ({
    type: 'script',
    common: { name: 'x', engineType: 'Javascript/js', source, enabled: false, ...extra },
    native: {},
});

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

/** Ask in the admin chat and wait until the agent is done. */
async function askAdmin(agent, text) {
    await call(agent, 'chatSend', { text });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
}

/** The open question of the admin chat, once it is there. */
async function questionOf(agent) {
    let question;
    await waitFor(async () => (question = (await call(agent, 'chatHistory')).question), 'the question');
    return question;
}

/** The result of the last call of a tool in the admin chat. */
async function resultOf(agent, tool) {
    const history = await call(agent, 'chatHistory');
    return String(history.entries.findLast(e => e.detail?.name === tool)?.detail?.result ?? '');
}

test('scriptIdOf: a name goes to the folder of the agent, a full id stays, odd characters go', () => {
    assert.equal(scriptIdOf('Evening light'), OWN);
    assert.equal(scriptIdOf(' script.js.heating.boiler '), FOREIGN);
    assert.equal(scriptIdOf('Свет вечером!'), 'script.js.pi-agent.Свет_вечером');
    assert.equal(scriptIdOf('script.js..x'), '');
    assert.equal(scriptIdOf(''), '');
});

test('lineDiff: added and removed lines with context, a new script all added', () => {
    assert.equal(lineDiff('', 'a\nb'), '+ a\n+ b');
    const diff = lineDiff('1\n2\n3\n4\n5\n6\n7\n8', '1\n2\n3\n4\nfive\n6\n7\n8');
    assert.equal(diff, '…\n  3\n  4\n- 5\n+ five\n  6\n  7\n…');
});

test('scriptWarnings: risky calls and writes outside the write permissions', () => {
    const allowed = id => id.startsWith('0_userdata.0.');
    assert.deepEqual(scriptWarnings("setState('0_userdata.0.x', 1);", allowed), []);
    assert.deepEqual(scriptWarnings(SOURCE, allowed), ['setState outside the write permissions: hm-rpc.0.ABC.1.STATE']);
    assert.deepEqual(scriptWarnings("exec('ls'); const fs = require('fs'); setState(id, 1);", allowed), [
        'exec',
        'require',
        'setState with a computed id',
    ]);
});

test('syntaxError: the line of the error; await at the top is fine; TypeScript is not checked', () => {
    assert.equal(syntaxError('const x = await getStateAsync("a");\nlog(x);', 'Javascript/js'), '');
    assert.match(syntaxError('log(1);\nconst = 2;', 'Javascript/js'), /\(line 2\)$/);
    assert.equal(syntaxError('const x: number = ;', 'TypeScript/ts'), '');
});

test('questions: messenger text with the diff, spoken text with the summary and the warnings', () => {
    const val = { id: OWN, isNew: true, running: false, warnings: ['exec'], diff: '+ exec("ls");' };
    assert.equal(
        scriptQuestion('scriptSave', val, { mark: s => `[${s}]`, pre: s => `<${s}>`, maxDiff: 100 }),
        `⚠️ Save the script [${OWN}] (new, it stays stopped)?\n⚠ exec\n<+ exec("ls");>`,
    );
    assert.equal(
        confirmationQuestion('ru', {
            what: 'Evening light',
            action: 'scriptSave',
            val: { ...val, summary: 'Каждый день в 20:00 включает свет.' },
        }),
        'Сохранить новый скрипт Evening light? Каждый день в 20:00 включает свет. Внимание, в коде: exec. Скажи да или нет. [[LISTEN]]',
    );
    assert.equal(
        confirmationQuestion('de', { what: 'Boiler', action: 'scriptEnable', val: { enabled: true } }),
        'Das Skript Boiler starten? Sag ja oder nein. [[LISTEN]]',
    );
});

test('questions: the spoken warnings are in the language of the question, the messenger text stays English', () => {
    // was "Внимание, в коде: setState with a computed id." in a Russian question
    const source =
        'setState(id, true);\nsetState("hm-rpc.0.ABC.1.STATE", true);\nwriteFile("x", "y", "z");\nexec("ls");';
    const warnings = scriptWarnings(source, () => false);
    const val = { id: OWN, isNew: true, running: false, warnings, diff: '', summary: 'Переключает свет.' };
    assert.equal(
        confirmationQuestion('ru', { what: 'Свет', action: 'scriptSave', val }),
        'Сохранить новый скрипт Свет? Переключает свет. Внимание, в коде: exec, доступ к файлам, ' +
            'setState вне прав на запись: hm-rpc.0.ABC.1.STATE, setState с вычисляемым ID. Скажи да или нет. [[LISTEN]]',
    );
    assert.match(
        confirmationQuestion('de', { what: 'Licht', action: 'scriptSave', val }),
        /Dateizugriffe, setState außerhalb/,
    );
    assert.match(
        confirmationQuestion('en', { what: 'Light', action: 'scriptSave', val }),
        /file access, setState outside/,
    );
    const messenger = scriptQuestion('scriptSave', val, { mark: s => s, pre: s => s, maxDiff: 100 });
    assert.match(messenger, /⚠ setState with a computed id/);
});

test('history: keeps five versions per script and survives a new start', () => {
    const dir = tmp();
    const history = createScriptHistory(dir);
    history.load();
    for (let k = 1; k <= 7; k++) {
        history.push(OWN, `v${k}`);
    }
    const again = createScriptHistory(dir);
    again.load();
    assert.equal(again.count(OWN), 5);
    assert.equal(again.peek(OWN), 'v7');
    again.pop(OWN);
    assert.equal(again.peek(OWN), 'v6');
});

test('switched off: save_script is blocked and nothing is written', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false },
        responses: [
            f.fauxAssistantMessage(
                f.fauxToolCall('save_script', { id: 'Evening light', source: SOURCE, summary: 's' }),
                {
                    stopReason: 'toolUse',
                },
            ),
            f.fauxAssistantMessage('Switched off.'),
        ],
    });
    await askAdmin(agent, 'write a script');
    assert.equal(db.objects[OWN], undefined);
    assert.equal((await call(agent, 'chatHistory')).question, null);
    await stopAgent(agent);
});

test('save in the own folder: confirmed with the diff, created stopped, then started with its own confirmation', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, allowScripts: true },
        responses: [
            f.fauxAssistantMessage(
                f.fauxToolCall('save_script', { id: 'Evening light', source: SOURCE, summary: 'light at 20:00' }),
                { stopReason: 'toolUse' },
            ),
            f.fauxAssistantMessage('Saved.'),
            f.fauxAssistantMessage(f.fauxToolCall('set_script_enabled', { id: OWN, enabled: true }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Started.'),
        ],
    });
    agent.scriptCheckMs = 10;
    await call(agent, 'chatSend', { text: 'write a script' });
    let question = await questionOf(agent);
    assert.equal(question.action, 'scriptSave');
    assert.equal(question.val.isNew, true);
    assert.deepEqual(question.val.warnings, ['setState outside the write permissions: hm-rpc.0.ABC.1.STATE']);
    assert.match(question.val.diff, /^\+ schedule/);
    assert.equal(db.objects[OWN], undefined, 'nothing saved before the answer');
    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    assert.equal(db.objects[OWN].common.source, SOURCE);
    assert.equal(db.objects[OWN].common.enabled, false, 'a new script stays stopped');
    assert.equal(db.objects[OWN].common.engine, 'system.adapter.javascript.0');
    assert.equal(db.objects['script.js.pi-agent'].type, 'channel', 'the folder is created');

    await call(agent, 'chatSend', { text: 'start it' });
    question = await questionOf(agent);
    assert.deepEqual([question.action, question.val.enabled], ['scriptEnable', true]);
    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    assert.equal(db.objects[OWN].common.enabled, true);
    assert.match(await resultOf(agent, 'set_script_enabled'), /^Started: .*No warnings or errors/);
    await stopAgent(agent);
});

test('other scripts need their own setting; Blockly stays read-only', async () => {
    const f = await faux();
    const tryIt = async (config, id) => {
        const { agent, db } = await startAgent({
            dataDir: tmp(),
            config: { dryRun: false, allowScripts: true, ...config },
            seed: {
                objects: {
                    [FOREIGN]: script('log(1);'),
                    'script.js.pi-agent.blocks': script('<xml/>', { engineType: 'Blockly' }),
                },
            },
            responses: [
                f.fauxAssistantMessage(f.fauxToolCall('save_script', { id, source: 'log(2);', summary: 's' }), {
                    stopReason: 'toolUse',
                }),
                f.fauxAssistantMessage('Done.'),
            ],
        });
        await askAdmin(agent, 'change it');
        const result = await resultOf(agent, 'save_script');
        const source = db.objects[id].common.source;
        await stopAgent(agent);
        return { result, source };
    };
    let outcome = await tryIt({}, FOREIGN);
    assert.match(outcome.result, /not in the folder of the agent/);
    assert.equal(outcome.source, 'log(1);');
    outcome = await tryIt({}, 'script.js.pi-agent.blocks');
    assert.match(outcome.result, /Blockly script, which the agent only reads/);
    outcome = await tryIt({ allowForeignScripts: true, dryRun: true }, FOREIGN);
    assert.match(outcome.result, /^DRY RUN - NOTHING WAS SAVED/);
});

test('a syntax error goes back to the model before the user is asked', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, allowScripts: true },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('save_script', { id: 'x', source: 'log(;', summary: 's' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Fixing it.'),
        ],
    });
    await askAdmin(agent, 'write a script');
    assert.match(await resultOf(agent, 'save_script'), /the user was not asked: syntax error .*\(line 1\)/);
    assert.equal(db.objects['script.js.pi-agent.x'], undefined);
    await stopAgent(agent);
});

test('change of a running script, then revert: the old version comes back and the script is stopped', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, allowScripts: true },
        seed: { objects: { [OWN]: script('log("old");', { enabled: true }) } },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('save_script', { id: OWN, source: 'log("new");', summary: 's' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Changed.'),
            f.fauxAssistantMessage(f.fauxToolCall('revert_script', { id: OWN }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Reverted.'),
        ],
    });
    await call(agent, 'chatSend', { text: 'change it' });
    let question = await questionOf(agent);
    assert.deepEqual([question.val.isNew, question.val.running], [false, true]);
    assert.equal(question.val.diff, '- log("old");\n+ log("new");');
    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    assert.equal(db.objects[OWN].common.source, 'log("new");');
    assert.equal(db.objects[OWN].common.enabled, true, 'a running script keeps running');

    await call(agent, 'chatSend', { text: 'undo it' });
    question = await questionOf(agent);
    assert.equal(question.action, 'scriptRevert');
    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    await waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
    assert.equal(db.objects[OWN].common.source, 'log("old");');
    assert.equal(db.objects[OWN].common.enabled, false);
    await stopAgent(agent);
});

test('voice: scripts are confirmed by text only with "Confirm scripts by voice"', async () => {
    const f = await faux();
    const voice = async scriptVoice => {
        const { agent, db } = await startAgent({
            dataDir: tmp(),
            config: { dryRun: false, allowScripts: true, textConfirmation: true, scriptVoice },
            seed: { objects: { 'system.config': { type: 'config', common: { language: 'ru' }, native: {} } } },
            responses: [
                f.fauxAssistantMessage(
                    f.fauxToolCall('save_script', { id: 'Evening light', source: 'log(1);', summary: 'Пишет в лог.' }),
                    { stopReason: 'toolUse' },
                ),
                f.fauxAssistantMessage('Готово.'),
            ],
        });
        const ask = async text => {
            await agent.onMessage({
                command: 'ask',
                message: { text, conversation: 'kitchen' },
                from: 'system.adapter.assistant.0',
                callback: 'cb',
            });
            return agent.sent.at(-1)[2].answer;
        };
        const first = await ask('Напиши скрипт');
        const second = scriptVoice ? await ask('да') : '';
        const saved = Boolean(db.objects[OWN]);
        await stopAgent(agent);
        return { first, second, saved };
    };
    const on = await voice(true);
    assert.equal(on.first, 'Сохранить новый скрипт Evening light? Пишет в лог. Скажи да или нет. [[LISTEN]]');
    assert.equal(on.second, 'Готово.');
    assert.equal(on.saved, true);
    const off = await voice(false);
    assert.equal(off.first, 'Готово.', 'no question by voice without the setting');
    assert.equal(off.saved, false);
});
