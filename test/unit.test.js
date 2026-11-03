'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseAllowlist, scopePattern, parseWriteRules, isWriteAllowed, requestIdFor } = require('../lib/guard');
const { coerce, nameText } = require('../lib/tools');

test('allowlist: empty list denies everything', () => {
	assert.equal(isWriteAllowed('hm-rpc.0.Licht', parseAllowlist('')), false);
});

test('allowlist: matches, comments, blank lines', () => {
	const list = parseAllowlist('# rooms\n^hm-rpc\\.0\\.Wohnzimmer\\.\n\n^javascript\\.0\\.agent\\.');
	assert.equal(list.length, 2);
	assert.equal(isWriteAllowed('hm-rpc.0.Wohnzimmer.Licht', list), true);
	assert.equal(isWriteAllowed('hm-rpc.0.Haustuer.Schloss', list), false);
});

test('allowlist: a broken line is reported and skipped, never opens the list', () => {
	const bad = [];
	const list = parseAllowlist('(unclosed\n^ok\\.', (line, msg) => bad.push([line, msg]));
	assert.equal(list.length, 1);
	assert.equal(bad.length, 1);
	assert.equal(isWriteAllowed('anything', list), false);
});

test('requestId: same trigger gives the same id, another value another id', () => {
	assert.equal(requestIdFor(crypto, 1, 'a'), requestIdFor(crypto, 1, 'a'));
	assert.notEqual(requestIdFor(crypto, 1, 'a'), requestIdFor(crypto, 1, 'b'));
});

test('coerce: converts to the declared state type', () => {
	assert.equal(coerce('true', 'boolean'), true);
	assert.equal(coerce('false', 'boolean'), false);
	assert.equal(coerce('21.5', 'number'), 21.5);
	assert.equal(coerce(5, 'string'), '5');
	assert.throws(() => coerce('abc', 'number'));
});

test('nameText: handles translated names', () => {
	assert.equal(nameText({ en: 'Light', de: 'Licht' }), 'Light');
	assert.equal(nameText('Plain'), 'Plain');
	assert.equal(nameText(undefined), '');
});

test('io-package: the API keys and the SFTP password are declared encrypted and protected at the top level', () => {
	const io = require('../io-package.json');
	// js-controller reads these two lists from the top level only; inside "common" they are ignored.
	assert.deepEqual(io.encryptedNative, ['apiKey', 'remotePassword', 'speechApiKey']);
	assert.deepEqual(io.protectedNative, ['apiKey', 'remotePassword', 'speechApiKey']);
	assert.equal('encryptedNative' in io.common, false);
	assert.equal('protectedNative' in io.common, false);
});

/**
 * Every item of the admin page, also those inside tabs and panels.
 *
 * @param {Record<string, any>} items items of a level
 * @returns {Array<[string, any]>} key and item
 */
function allItems(items) {
    return Object.entries(items).flatMap(([key, item]) =>
        item.type === 'tabs' || item.type === 'panel' ? [[key, item], ...allItems(item.items)] : [[key, item]],
    );
}

test('jsonConfig: every field has xs..xl from 1 to 12, xs 12, never wider on a larger display (repochecker E5507-E5511)', () => {
	const config = require('../admin/jsonConfig.json');
	const sizes = ['xs', 'sm', 'md', 'lg', 'xl'];
	// the repochecker does not ask for sizes of these (sizesOptional)
	const optional = ['checkDocker', 'custom', 'deviceManager', 'divider', 'header', 'infoBox', 'staticImage'];
	for (const [key, item] of allItems(config.items)) {
		if (item.type === 'tabs' || item.type === 'panel' || optional.includes(item.type)) {
			continue;
		}
		for (const size of sizes) {
			assert.ok(item[size] >= 1 && item[size] <= 12, `${key}: ${size} is ${item[size]}`);
		}
		assert.equal(item.xs, 12, `${key}: xs`);
		for (let i = 1; i < sizes.length; i++) {
			assert.ok(
				item[sizes[i]] <= item[sizes[i - 1]],
				`${key}: ${sizes[i]} (${item[sizes[i]]}) is wider than ${sizes[i - 1]} (${item[sizes[i - 1]]})`,
			);
		}
	}
});

test('jsonConfig: only component types the admin knows', () => {
	const config = require('../admin/jsonConfig.json');
	const known = new Set([
		'text',
		'password',
		'number',
		'checkbox',
		'select',
		'instance',
		'header',
		'autocompleteSendTo',
		'staticText',
		'table',
		'tabs',
		'panel',
		'sendTo',
		'credential', // admin 8: a credential of the central credential store
		'selectSendTo',
	]);
	for (const [key, item] of allItems(config.items)) {
		assert.ok(known.has(item.type), `${key} uses unknown type "${item.type}"`);
		for (const column of item.type === 'table' ? item.items : []) {
			assert.ok(known.has(column.type), `${key}.${column.attr} uses unknown type "${column.type}"`);
		}
	}
});

/** Brand names that read the same in every language. */
const SAME_IN_ALL_LANGUAGES = new Set([]);

test('i18n: eleven languages for instance objects, same admin keys, nothing left in English', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const io = require('../io-package.json');
    const langs = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
    assert.equal('title' in io.common, false, 'common.title is deprecated');
    for (const obj of io.instanceObjects) {
        assert.deepEqual(Object.keys(obj.common.name).sort(), [...langs].sort(), obj._id);
    }
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../admin/i18n/en.json'), 'utf8'));
    for (const lang of langs.filter(l => l !== 'en')) {
        const tr = JSON.parse(fs.readFileSync(path.join(__dirname, `../admin/i18n/${lang}.json`), 'utf8'));
        assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort(), `keys of ${lang}`);
        for (const key of Object.keys(en)) {
            if (!SAME_IN_ALL_LANGUAGES.has(key)) {
                assert.notEqual(tr[key], en[key], `${lang}: "${key}" is still English`);
            }
        }
    }
});

test('jsonConfig: every label, help and header text has a translation key', () => {
    const config = require('../admin/jsonConfig.json');
    const en = require('../admin/i18n/en.json');
    for (const [key, item] of allItems(config.items)) {
        for (const field of ['label', 'help', 'text', 'placeholder']) {
            if (item[field]) {
                assert.ok(item[field] in en, `${key}.${field} "${item[field]}" has no translation`);
            }
        }
        for (const column of item.type === 'table' ? item.items : []) {
            assert.ok(column.title in en, `${key}.${column.attr} title "${column.title}" has no translation`);
        }
    }
});

test('objects: instanceObjects keep only info, the rest is created in code with eleven languages', () => {
    const io = require('../io-package.json');
    const { OBJECTS } = require('../lib/objects');
    const names = require('../lib/object-names.json');
    assert.deepEqual(
        io.instanceObjects.map(o => o._id),
        ['info', 'info.connection'],
        'chat.* and telegram.* must not be in instanceObjects (js-controller resets their ACL at start)',
    );
    for (const { id } of OBJECTS) {
        assert.equal(Object.keys(names[id] || {}).length, 11, id);
    }
});

test('io-package: the messagebox is really enabled (sendTo reaches the adapter)', () => {
    const io = require('../io-package.json');
    // js-controller (isMessageboxSupported): when common.supportedMessages exists, common.messagebox is ignored and
    // the adapter subscribes to messages only if one of its values is true. {custom: false} switched sendTo off.
    const supported = io.common.supportedMessages;
    const enabled = supported && typeof supported === 'object'
        ? Object.values(supported).some(v => v !== false)
        : Boolean(io.common.messagebox);
    assert.ok(enabled, 'sendTo would never reach the adapter');
});

test('jsonConfig: every field of the admin page is a native setting with a default', () => {
    const config = require('../admin/jsonConfig.json');
    const io = require('../io-package.json');
    const fields = allItems(config.items).filter(([key, item]) => !key.startsWith('_') && !['tabs', 'header', 'staticText', 'sendTo'].includes(item.type));
    for (const [key] of fields) {
        assert.ok(key in io.native, `${key} has no default in io-package native`);
    }
});

test('write rules: a scope covers the id and everything below it, "*" stands for any text', () => {
    const instance = scopePattern('hm-rpc.0');
    assert.ok(instance.test('hm-rpc.0'));
    assert.ok(instance.test('hm-rpc.0.ABC.1.STATE'));
    assert.ok(!instance.test('hm-rpc.01.ABC'), 'hm-rpc.01 is another instance');
    assert.ok(!instance.test('xhm-rpc.0.ABC'));
    const pattern = scopePattern(' hm-rpc.0.*.STATE ');
    assert.ok(pattern.test('hm-rpc.0.ABC.1.STATE'));
    assert.ok(!pattern.test('hm-rpc.0.ABC.1.STATE.x'));
    assert.ok(scopePattern('javascript.0.agent(1)').test('javascript.0.agent(1).x'), 'regex characters are literal');
    assert.equal(scopePattern('  '), null);
});

test('write rules: only rows with "write" allow; "confirm" counts only together with "write"', () => {
    const { allow, confirm } = parseWriteRules([
        { scope: 'hm-rpc.0', write: true, confirm: false },
        { scope: 'shelly.0', write: false, confirm: true },
        { scope: 'zigbee.0.*.lock', write: true, confirm: true },
        { scope: '', write: true, confirm: true },
        null,
    ]);
    assert.ok(isWriteAllowed('hm-rpc.0.a', allow));
    assert.ok(!isWriteAllowed('shelly.0.a', allow));
    assert.ok(isWriteAllowed('zigbee.0.door.lock', allow));
    assert.ok(!isWriteAllowed('hm-rpc.0.a', confirm));
    assert.ok(!isWriteAllowed('shelly.0.a', confirm));
    assert.ok(isWriteAllowed('zigbee.0.door.lock', confirm));
    assert.deepEqual(parseWriteRules(undefined), { allow: [], confirm: [], restart: [] });
});
