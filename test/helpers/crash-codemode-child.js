'use strict';

// Child process for the code mode crash test: a script reads the lamp, then switches it; the process dies the hard way
// (exit 137, no unload) right after the write reached the state, in the middle of the script.

const { startAgent, NAMESPACE } = require('./agent-harness');
const { CRASH_SEED, CRASH_CONFIG, CRASH_SCRIPT } = require('./crash-fixture');

async function main() {
    const dataDir = process.argv[2];
    const faux = await import('@earendil-works/pi-ai/providers/faux');
    const { agent } = await startAgent({
        dataDir,
        config: { ...CRASH_CONFIG, codeMode: true },
        seed: CRASH_SEED,
        responses: [
            faux.fauxAssistantMessage(faux.fauxToolCall('codemode', { code: CRASH_SCRIPT }), {
                stopReason: 'toolUse',
            }),
        ],
        hooks: {
            setForeignState: () => process.exit(137),
        },
    });
    agent.emit('stateChange', `${NAMESPACE}.chat.input`, { val: 'Switch the lamp on', ack: false, ts: 1 });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
