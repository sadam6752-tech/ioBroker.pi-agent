'use strict';

const { parseAllowedUsers } = require('./telegram');

/**
 * Messenger instances (telegram, max) the agent talks through, from the table "messengers" of the settings.
 * Versions up to 0.0.5 had one instance in three single fields; they count as the first row while the
 * table is empty, so an update keeps working before the settings are migrated.
 *
 * @param {Partial<ioBroker.AdapterConfig>} config native configuration
 * @returns {Array<{ instance: string, allowed: Set<string>, prefix: string, voice: boolean, photos: boolean }>} enabled channels, unique by instance
 */
function channelsFromConfig(config) {
    const rows = Array.isArray(config.messengers) && config.messengers.length ? config.messengers : legacyRows(config);
    const seen = new Set();
    const channels = [];
    for (const row of rows) {
        const instance = String(row?.instance || '').trim();
        if (!instance || row.enabled === false || seen.has(instance)) {
            continue;
        }
        seen.add(instance);
        channels.push({
            instance,
            allowed: parseAllowedUsers(row.users),
            prefix: String(row.prefix || '').trim(),
            // rows saved before 0.9.0 have no column "Voice"; speech recognition itself is off until it is set up
            voice: row.voice !== false,
            // rows saved before 0.9.6 have no column "Photos": off, an update does not start sending photos
            photos: row.photos === true,
        });
    }
    return channels;
}

/**
 * The three single fields of version 0.0.5 and earlier as one table row (or none).
 *
 * @param {Partial<ioBroker.AdapterConfig>} config native configuration
 * @returns {Array<{ enabled: boolean, instance: string, users: string, prefix: string, voice?: boolean, photos?: boolean }>} rows
 */
function legacyRows(config) {
    const instance = String(config.telegramInstance || '').trim();
    return instance
        ? [
              {
                  enabled: true,
                  instance,
                  users: String(config.telegramUsers || ''),
                  prefix: String(config.telegramPrefix || ''),
              },
          ]
        : [];
}

/**
 * Key of a chat in telegram.chats: the same chat id can exist on two bots.
 *
 * @param {string} instance telegram instance
 * @param {unknown} chatId chat id
 * @returns {string} "telegram.0/753441"
 */
function chatKey(instance, chatId) {
    return `${instance}/${chatId}`;
}

/**
 * Split a key of telegram.chats; keys of 0.0.5 and earlier had no instance.
 *
 * @param {string} key stored key
 * @param {string} fallbackInstance instance for a key without one
 * @returns {{ instance: string, chatId: string }} parts
 */
function parseChatKey(key, fallbackInstance) {
    const slash = key.lastIndexOf('/');
    return slash < 0
        ? { instance: fallbackInstance, chatId: key }
        : { instance: key.slice(0, slash), chatId: key.slice(slash + 1) };
}

/**
 * telegram.chats of 0.0.5 and earlier ("753441": id) with the instance in the key ("telegram.0/753441": id).
 *
 * @param {Record<string, unknown>} chats stored map
 * @param {string} fallbackInstance instance the old keys belong to
 * @returns {{ chats: Record<string, unknown>, changed: boolean }} migrated map
 */
function migrateChats(chats, fallbackInstance) {
    const old = key => !key.includes('/') && Boolean(fallbackInstance);
    const entries = Object.entries(chats).map(([key, id]) => [old(key) ? chatKey(fallbackInstance, key) : key, id]);
    return { chats: Object.fromEntries(entries), changed: Object.keys(chats).some(old) };
}

module.exports = { channelsFromConfig, legacyRows, chatKey, parseChatKey, migrateChats };
