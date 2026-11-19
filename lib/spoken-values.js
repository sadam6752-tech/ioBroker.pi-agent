'use strict';

// Values for a conversation whose answers are spoken (ioBroker.assistant sends `language`): temperatures, percentages
// and wind speeds as whole numbers. A rule in the instructions alone did not hold: the model read 0.6 °C from the
// weather states and said "0,6 bis 8 Grad" (2026-11-13). What the model never sees, it cannot read out.

/** Units whose values are spoken as whole numbers */
const WHOLE_UNITS = new Set(['°c', '°f', '°', 'k', '%', 'km/h', 'kmh', 'm/s', 'mph', 'kn', 'kt', 'bft']);

/**
 * @param {unknown} val value of a state
 * @param {unknown} unit `common.unit` of its object
 * @returns {unknown} the value rounded to a whole number when its unit is one of a temperature, a percentage or a wind
 *   speed; any other value as it is
 */
function spokenValue(val, unit) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
        return val;
    }
    if (
        !WHOLE_UNITS.has(
            String(unit ?? '')
                .trim()
                .toLowerCase(),
        )
    ) {
        return val;
    }
    // -0.4 rounds to -0, which reads as "minus null" in some languages
    return Math.round(val) || 0;
}

module.exports = { spokenValue, WHOLE_UNITS };
