'use strict';

/** One writable lamp that is on the allowlist; shared by the crash child and the test. */
const CRASH_SEED = {
    objects: {
        'x.0.lamp': { type: 'state', common: { name: 'Lamp', type: 'boolean', role: 'switch', write: true } },
    },
    states: { 'x.0.lamp': { val: false, ack: true, ts: 1 } },
};

const CRASH_CONFIG = { writeAllow: '^x\\.0\\.', dryRun: false };

/** The script of the code mode crash test: a read, then the write the process dies in. */
const CRASH_SCRIPT = `const before = await tools.get_state({ id: 'x.0.lamp' });
await tools.set_state({ id: 'x.0.lamp', val: true });
text('DONE, was ' + before.val);`;

module.exports = { CRASH_SEED, CRASH_CONFIG, CRASH_SCRIPT };
