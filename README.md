![Logo](admin/pi-agent.png)

# ioBroker.pi-agent

[![NPM version](https://img.shields.io/npm/v/iobroker.pi-agent.svg)](https://www.npmjs.com/package/iobroker.pi-agent)
[![Downloads](https://img.shields.io/npm/dm/iobroker.pi-agent.svg)](https://www.npmjs.com/package/iobroker.pi-agent)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.pi-agent.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.pi-agent.png?downloads=true)](https://nodei.co/npm/iobroker.pi-agent/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.pi-agent/workflows/Test%20and%20Release/badge.svg)

A language model agent for ioBroker that survives restarts and crashes. It is built on
[Pi Durable](https://earendil.com/posts/pi-durable/): every model call and tool call is stored as a checkpoint
before it runs, so an interrupted request continues after the adapter starts again instead of starting over.

## What it does

- Reads and searches states through the tools `search_objects`, `get_state` (one id or a `*` pattern) and
  `list_instances`. These tools may be repeated safely. Both show type, unit, writable, and where the state has them
  min, max and the allowed values (`common.states`), so the agent writes the value the device expects.
- Finds the states of a room and/or a function as set up in ioBroker (`enum.rooms`, `enum.functions`) with
  `find_states`, e.g. room "Küche" and function "Licht" for "the lights in the kitchen"; `list_rooms` and
  `list_functions` show what exists. Names match in every language of the enum and in part; a member that is a
  device or channel brings the states below it.
- `list_instances` starts from the instance objects and reads `alive` and `connected` of each instance by its exact id.
  A `*` pattern only finds states that have an object, so a stale `alive` value of an instance whose state object is
  gone is missing from a pattern query but not from `list_instances`.
- Logs every tool call as one line: `Tool <name> <arguments> -> <outcome>` (blocked writes as a warning).
- Writes states through `set_state`. This tool is **never repeated** after an interruption: the model is told that the
  call was interrupted and checks the actual value first. A light cannot be switched twice by a restart.
- Writes only to states the **write permissions** allow. Everything else is blocked before it runs.
- Answers each request exactly once. The request id is derived from the triggering state, so a repeated trigger finds the
  original request.

## Requirements

- Node.js 22.19.0 or newer, js-controller 6.0.11 or newer, admin 8.0.0 or newer.
- An API key of the chosen provider: Anthropic, OpenAI, DeepSeek, Google Gemini or OpenRouter, or an OpenAI-compatible server (a
  local one such as Ollama needs no key). Or the system-wide AI settings of admin (System settings, tab "AI"), which
  name provider, model and key once for the whole system.
- The adapter runs as its own process (not in compact mode). It keeps long-running model requests and a conversation
  store open, and its dependencies are large; running it apart keeps a fault or a memory peak away from other adapters.
  The API key is kept in memory of this instance only and is never put into the process environment.

## Configuration

The settings have four tabs: **General**, **Write permissions**, **Messengers** and **Backup** (see below).

| Setting         | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| Key source      | **System-wide AI settings of admin**: provider, model, base URL and key come from the system settings of admin, tab "AI" (object `system.ai`); a change there restarts the instance. **Store the key in the adapter** or **Central credential store**: the settings below. An instance with neither a key nor an OpenAI-compatible server of its own also takes the system-wide settings, so a new instance works without any setting once they are set up. |
| Provider, Model | The language model. The model field lists the models of the chosen provider (the instance must be running for the list); any other model ID can be typed in. Empty: the default of the provider (`claude-sonnet-5-5`, `gpt-6-sol`, `deepseek-flash`, `gemini-3.5-flash`, `anthropic/claude-sonnet-5.5`). |
| Base URL        | Only for **OpenAI-compatible (own URL)**: the endpoint of the server, see below. |
| API key         | **Store the key in the adapter** (the field "API key", stored encrypted) or **Central credential store**: a credential of the central credential store of admin 8, chosen in "API key credential". A changed credential restarts the instance with the new key. |
| Test connection | Asks the model one short question with the values of the form, saved or not, and shows the answer or the error. The instance must be running. |
| Simulation mode (nothing is switched) | On by default. The agent says what it would switch, but no state is written and no instance is restarted. |
| Long-term memory | On by default: the agent keeps facts across all conversations, see below. |
| Write permissions | Table, one row per scope: an instance or object ID (`hm-rpc.0` covers everything below it) or a pattern with `*` (`hm-rpc.0.*.STATE`), with the checkboxes "Write allowed", "Confirmation required" and "Restart allowed" (only for a row with a whole instance, see below). **Add installed instances** adds a row for every installed instance that has none, with nothing allowed yet. States that match no row can only be read. |
| Write allowlist, Confirmation required | Under "Advanced": regular expressions, one per line, in addition to the table (the settings of 0.0.5 and earlier keep working). |
| Time zone       | IANA name such as `Europe/Berlin` for reminders, `get_time` and history times, chosen from a list with the current UTC offsets (the instance must be running for the list) or typed in. Empty: the time zone of the ioBroker server. |
| History instance | `history`, `sql` or `influxdb` instance for `get_history`. Empty: the default history of the system settings. |
| Instructions    | Text appended to the system prompt, for example room names and house rules. The agent answers in the language of the question; a language named here (e.g. "Always answer in German.") wins. |
| Messengers      | Table, one row per `telegram` or `max` instance (bot): active, instance, allowed users, prefix. No row: no messenger is used. |
| ↳ Allowed users | User ID, user name or first name (as in the messenger adapter), separated by commas. Messages from anyone else are ignored. |
| ↳ Prefix        | Only messages that start with it go to the agent, e.g. `/ai`. Empty: every message of an allowed user. |

Example of the table "Write permissions":

| Scope                  | Write allowed | Confirmation required |
| ---------------------- | ------------- | --------------------- |
| `hm-rpc.0.Wohnzimmer`  | ✓             |                       |
| `zigbee.0.*.lock`      | ✓             | ✓                     |
| `javascript.0.agent`   | ✓             |                       |

The same as regular expressions under "Advanced":

```
^hm-rpc\.0\.Wohnzimmer\.
^zigbee\.0\..*\.lock$
^javascript\.0\.agent\.
```

Start with simulation mode on, watch the log, and only then switch it off.

## Usage

### Chat in the admin

The menu entry **Pi Agent** on the left side of the admin opens a chat with the agent:

- Every ioBroker user has a conversation of their own; **New conversation** starts over. The old conversation is
  deleted from the store at the next start of the instance, after a safety copy (`pi-agent-prepurge-….sqlite.gz` in the
  backup folder). A conversation with a reminder that is not due yet is deleted after the reminder. The deletion relies
  on the storage schema of Pi Durable; with an unknown schema version (after an update of Pi Durable) nothing is deleted.
- The answer is shown formatted, with the tool calls of the agent above it.
- A write on the "Confirmation required" list is asked in the chat with ✅/❌ buttons.
- A request keeps running when the page is closed; the answer is in the chat when it is opened again.
- Reminders of the conversation appear in the chat (kept until the adapter restarts).
- **Details** (remembered in the browser) shows under every answer the provider, the model, the time, the tokens
  (in, out, cached) and the number of model calls, and for every tool call its arguments, the start of its result and
  its time; a blocked or failed call is red.
- Administrators (group "administrator") choose in the list at the top another conversation: the chats of the
  messengers, of the other admin users and of `sendTo` callers such as ioBroker.assistant (one per room or satellite).
  These are shown read only, and refreshed every few seconds.

### States and scripts

Write a text to `pi-agent.0.chat.input`. The answer appears in `pi-agent.0.chat.answer`. From a script:

```js
sendTo('pi-agent.0', 'ask', { text: 'Is the living room light on?' }, result => log(result.answer));
```

The answer of a `sendTo` request comes back only through the callback (`result.answer`, or `result.error`); it is not
written to `chat.answer`.

Without further fields, all `sendTo` requests share one conversation. A caller that serves several people or rooms
(for example a voice assistant) can give each of them a conversation of its own, with its own history and its own
instructions:

```js
sendTo('pi-agent.0', 'ask', {
    text: 'Is the light on?',
    conversation: 'kitchen', // own conversation of this caller; up to 100 characters
    instructions: 'Answer in one or two short sentences without Markdown; the answer is spoken.', // optional
    requestId: 'kitchen-1730123456789', // optional: a repeated request with the same id is answered once
}, result => log(result.answer));
```

The conversations are kept per sending instance (`pi-agent.0.telegram.chats` lists them as
`sendTo:<instance>/<conversation>`). Changed instructions apply from the next request of the conversation on. Writes on
the "Confirmation required" list cannot be confirmed in such a conversation and are blocked.

`pi-agent.0.chat.pending` lists the requests that were accepted but not answered yet. If the adapter stops in the
middle, they continue on the next start. The answer of a request from `chat.input` or `sendTo` is then written to
`chat.answer` (the `sendTo` caller is no longer waiting), the answer of a messenger request goes to its chat. A
`sendTo` caller that was interrupted gets `{ error: "Interrupted by shutdown; the request continues after the next start" }`.

### Confirmation, reminders, history, usage

- **Confirmation:** a write to a state on the "Confirmation required" list is asked in the messenger chat or in the
  admin chat of the conversation with ✅/❌ buttons. Only "Yes" lets it happen; "No", no answer (10 minutes), or a request that did not
  come from a messenger blocks it. The answer is stored with the call, so a restart does not ask twice. In simulation mode nothing is
  written, so nothing is asked.
- **Reminders:** `remind_me` sends a message later (at most 7 days ahead) to the chat of the conversation, or to
  `chat.answer`. The reminder waits in the conversation store and survives restarts.
- **History:** `get_history` reads past values (up to 31 days, averaged to at most 200 values) from the history
  instance.
- **Usage:** `pi-agent.0.usage.*` shows input, output and total tokens and the cost in USD over all conversations
  (the cost needs prices in the model catalog; it can stay 0 for a provider without them), `usage.json` per model.

### Messengers: Telegram and MAX

Add a row to the table "Messengers" with **+**, select a `telegram` or `max` instance, enter the allowed users and,
if the bot also serves other scripts, a prefix such as `/ai`. Then write to the bot: `/ai Is the living room light on?`
Messenger adapters that can only send (e.g. WhatsApp, Signal, Pushover) cannot be used for a chat.

- Several bots can talk to the agent, each with its own users and prefix. Answers, confirmations and reminders go back
  through the bot the request came from.
- Every chat has its own conversation with its own history; `pi-agent.0.telegram.chats` maps `<instance>/<chat id>`
  to them.
- Settings of 0.0.5 and earlier (one instance in single fields) are moved into the table at the first start, which
  restarts the instance once. Existing chats keep their conversation.
- Messages from users who are not on the list are ignored and logged as a warning. An empty list allows nobody.
- A first name such as `Alex` counts only for users the messenger adapter knows (authenticated in the telegram
  adapter, `max.0.users.<id>` in the max adapter), because anybody can choose any first name. Two known users with the same first name are both allowed; use the user name
  or the ID to tell them apart.
- A message that the messenger adapter delivers twice is answered once.
- Long answers are split into several messages.
- **Telegram:** Markdown of the model is sent as Telegram HTML (bold, italic, code, links).
- **MAX** (adapter `max` 0.1.12 or newer): answers are plain text. In a private dialog the answer goes to the user, in
  a group to the group. MAX has no "ask", so a confirmation sends callback buttons; the pressed button comes back as
  `communicate.request`, is answered with `answerCallback` and never reaches the model.

### DeepSeek

Select **DeepSeek** as provider and enter a key from the DeepSeek platform. Available models: `deepseek-flash`
(default, fast) and `deepseek-v4-pro`. Requests go to `https://api.deepseek.com`.

### OpenAI-compatible servers

Select **OpenAI-compatible (own URL)** for any server with the OpenAI chat completions API, local or in the cloud:

| Server     | Base URL                              | API key  |
| ---------- | ------------------------------------- | -------- |
| Ollama     | `http://<host>:11434/v1`              | none     |
| LM Studio  | `http://<host>:1234/v1`               | none     |
| vLLM       | `http://<host>:8000/v1`               | optional |
| Groq       | `https://api.groq.com/openai/v1`      | required |
| OpenRouter | `https://openrouter.ai/api/v1`        | required |

- The model field lists what the server reports at `<base URL>/models`; the model ID is required.
- The model must support tool calling, otherwise the agent can neither read nor write states.
- The adapter does not know the limits of such a model; it assumes a context of 128k tokens and at most 8192 tokens
  per answer, and it reports no cost.

## Security

- The model decides which tools to call. The write permissions and the simulation mode are your protection, not the prompt.
- The text of your requests and the values the agent reads are sent to the provider. Do not give it access to states
  that contain secrets.
- The conversations are stored unencrypted in the instance data directory (`session.sqlite`, SQLite built into
  Node.js). An installation that still has the JSONL store of version 0.0.1/0.0.2 (folder `session`) switches to
  SQLite at the first start without pending requests; the old folder is renamed to `session.jsonl-<date>` and kept.
  Earlier history is not carried over, and the messenger chats start new conversations.

## Notifications, scheduled writes, diagnostics

- `notify_when` tells the user in the chat of the conversation when a state meets a condition: `==`, `!=`, `>`,
  `<`, `>=`, `<=` or `changes`, optionally for some minutes, e.g. "the washing machine is done" (power below 5 W
  for 3 minutes) or "the window is open for more than 10 minutes". Only values reported by the device (ack=true)
  count, not commands. A watch fires once and ends after 7 days at the latest; at most 20 at a time. The watches are
  kept in `scheduled.watches` and go on after a restart.
- `schedule_set_state` writes a state later ("switch the heater off at 23:00"), at most 7 days ahead. The write
  permissions and the confirmation are checked when it is planned; the permission is checked again when it is due,
  so a permission taken away in the meantime stops it. The user gets a message when it is done. It survives restarts.
- `list_scheduled` shows the reminders, scheduled writes and watches of the conversation, `cancel_scheduled` cancels
  one of them.
- `get_logs` reads the newest lines of the ioBroker log file (filtered by instance, level and a word, at most 50);
  `list_notifications` shows the notifications of ioBroker (the bell in admin). Both only read.
- A message from a conversation of a `sendTo` caller (e.g. ioBroker.assistant) goes to `chat.answer`.

## Scheduler fullcalendar

For actions that repeat (every weekday at 7:00), lie more than 7 days ahead, switch something on for a while, or
depend on a condition, the agent uses the adapter [fullcalendar](https://github.com/ioBroker/ioBroker.fullcalendar)
(3.3 or newer) through `send_to`: `addEvent`, `updateEvent`, `deleteEvent`, `listEvents`, `getCalendars`,
`enableCalendar`. The events appear in the calendar and can be changed there. What is planned the agent reads in
`fullcalendar.0.events.today`, `.tomorrow` and `.next`.

- It needs **Write allowed** for `fullcalendar.0` in "Write permissions".
- fullcalendar writes the state of an event by itself, later. So pi-agent checks that state (`oid`) against its own
  write permissions first: an event for a state pi-agent may not write is blocked. For `updateEvent` without `oid`
  the state of the event is looked up. Where the state, or the row of `fullcalendar.0`, has **Confirmation
  required**, the user confirms the event with what and when, e.g. "addEvent: hm-rpc.0.heater.STATE = false, start
  23:00, recurring daily".
- When fullcalendar is not installed, or not allowed, the agent tells the user what is missing and offers what works
  without it (`schedule_set_state` once within 7 days, `notify_when`, `remind_me`). The agent notices an
  installation without a restart.

## Restart of instances

The tool `restart_instance` restarts an adapter instance, e.g. "telegram does not answer, restart it":

- Only instances with **Restart allowed** in the table "Write permissions". The checkbox counts only for a row whose
  scope is a whole instance (`telegram.0`), not for an object ID or a pattern, and never for pi-agent or admin.
  Writing and restarting are allowed separately.
- Every restart is confirmed with ✅/❌ in the chat of the conversation (messenger or admin chat), also without
  "Confirmation required". A `sendTo` caller (e.g. ioBroker.assistant) cannot confirm, so a restart from there is
  blocked.
- The restart works like the restart button of admin. The agent then waits up to 45 seconds until the instance runs
  again and says so. A switched-off instance is not switched on. In simulation mode nothing is restarted.

## Commands to other adapters

The tool `send_to` sends a command to another adapter and returns its answer, e.g. instance `telegram.0`, command
`send`, message `{"text": "Hello"}`, or a text to speech adapter. The agent uses the command and message the adapter
documents.

- Only to instances whose row in "Write permissions" is the whole instance (`telegram.0`) with **Write allowed**; a
  row for some states of an instance (`telegram.0.communicate.*`) is not enough. Never to pi-agent or admin.
- With **Confirmation required** in that row, every command is confirmed with ✅/❌ in the chat first.
- The agent waits up to 30 seconds for the answer; many adapters do not answer, then the command may still have worked.
  A command is never sent a second time after an interruption. In simulation mode nothing is sent.

## Long-term memory

A conversation remembers everything said in it, but the conversations do not know each other. Facts that should
count everywhere go into the long-term memory:

- The agent keeps a fact with the tool `remember` when you ask it to ("remember: the lamp in the living room is
  hue.0.lamp3") or when you tell it a lasting preference, and removes it with `forget`.
- All facts go into the instructions of every conversation: messengers, admin chat and `sendTo` callers such as
  ioBroker.assistant. At most 100 facts, 500 characters each and 8,000 characters together.
- The facts are in the state `pi-agent.0.memory.list` (JSON). You can edit it there; the adapter takes the change over.
  `memory.count` shows how many there are. The memory is part of the backups of the conversations.
- The memory is shared by everyone who writes to the agent. Switch it off with "Long-term memory" in the settings.
  Never let it keep passwords or keys; the agent is told not to.

## Backup of the conversations

The conversations are in `session.sqlite` in the instance data directory, which the ioBroker backup does not
contain. The tab **Backup** saves them where it does:

- **Create backup** writes a consistent, gzip-compressed copy of the store, together with the assignment of the
  messenger chats, into the storage folder `pi-agent.0.storage/backups` (admin → **Files**). ioBroker and BackItUp
  backups take this folder along. The agent goes on working while the copy is made.
- **Automatic backup**: daily (default) or weekly, counted from the last backup, also after a restart; a backup that
  is due runs five minutes after the start. "Automatic backups to keep" (default 7) deletes the oldest automatic
  ones; backups made by hand and safety copies are never deleted.
- **Restore** replaces the conversations by the chosen backup and restarts the instance. The current conversations
  are saved first as a safety copy (`pi-agent-prerestore-….sqlite.gz`). Requests that were waiting are dropped.
- **Copy to an external server (SFTP)**: every backup is also copied to another computer, e.g. a NAS, with the SFTP
  protocol itself (no mount, no sudo). The upload is written as `.part` and renamed when it is complete; the
  fingerprint of the server can be pinned. Use a user that may only write into the target directory. The file holds
  the full text of the conversations and is not encrypted on the server.
- **Restore from the external server**, e.g. after a new installation: enter the SFTP settings, switch the copy on,
  save, then choose a backup on the server.

The states `backup.last`, `backup.size`, `backup.lastRemote` and `backup.remoteError` show the last backup and
the last copy.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.6.4 (2026-10-29)

- Scheduler fullcalendar: repeating, longer and timed actions go to fullcalendar through `send_to`, but only for
  states pi-agent may write; asked where "Confirmation required" is set
- When fullcalendar is not installed or not allowed, the agent tells the user what is missing

### 0.6.3 (2026-10-29)

- Tool `notify_when`: a message in the chat when a state meets a condition, also for some minutes
- Tool `schedule_set_state`: a write later; the permission is checked again when it is due
- Tools `list_scheduled` and `cancel_scheduled` for reminders, scheduled writes and watches
- Tools `get_logs` and `list_notifications` (read only)

### 0.6.2 (2026-10-29)

- Tools `list_rooms`, `list_functions` and `find_states`: the states of a room and/or a function as set up in
  ioBroker ("the lights in the kitchen")
- `search_objects` and `get_state` also show min, max and the allowed values of a state

### 0.6.1 (2026-10-29)

- Tool `send_to`: commands to other adapters (e.g. a Telegram message), only to instances with "Write allowed",
  confirmed where "Confirmation required" is set
- The agent answers in the language of the question, unless the instructions (of the user or of the calling adapter)
  name a language

### 0.6.0 (2026-10-28)

- Tool `restart_instance`: restarts adapter instances with "Restart allowed" in the write permissions, after a
  confirmation in the chat; never pi-agent or admin
- Long-term memory: facts kept across all conversations (tools `remember` and `forget`, state `memory.list`, part
  of the backups); switch "Long-term memory" in the settings

Older changelog entries can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 Alex <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
