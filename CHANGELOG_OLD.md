# Older Changelog

### 0.8.2 (2026-11-02)

- Confirmation by text: the question is in the `language` the caller sends with `ask` (ioBroker.assistant: the
  language of its satellites) instead of the system language; a satellite listening in Russian could not hear the
  German "Ja" it was asked for. The same yes twice ("Да да.", what speech recognition made of one "Да") is yes; the log
  shows what was heard
- One language in the question about a script: the summary the model writes follows the language of the user (it was
  German in a Russian conversation), and the warnings ("file access", "setState with a computed id" …) are spoken in
  the language of the question; the messenger chat and the log keep them in English

### 0.8.1 (2026-11-02)

- Scripts: new scripts in TypeScript when the user asks for it; TypeScript is checked for syntax errors too

### 0.8.0 (2026-11-02)

- Scripts of the javascript adapter, off by default: the agent creates and changes scripts in the folder
  `script.js.pi-agent` (other scripts with an extra setting), starts, stops and reverts them; every step is confirmed
  on its own with the change line by line, by voice only with its own setting

### 0.7.3 (2026-11-01)

- Write permissions: buttons above the table switch the column "Write allowed", "Confirmation required" or
  "Restart allowed" for all rows at once

### 0.7.2 (2026-10-30)

- Confirmation by text in sendTo conversations (e.g. ioBroker.assistant), off by default: the question is the answer
  of the request, the next request decides; only "yes" confirms, anything else or 2 minutes of silence is no

### 0.7.1 (2026-10-30)

- Review: the migrations of old settings change the own instance object with a partial update (extendForeignObject)
- One objectChange handler for all watched objects, registered once

### 0.7.0 (2026-10-30)

- Adapter updates: tools `list_updates`, `check_npm` and `update_adapter` (repository or npm), only with "Allow
  adapter updates", for adapters with "Write allowed" and pi-agent itself, always confirmed in the chat
- `list_notifications` reads the notifications from the host, as admin shows them

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

### 0.5.2 (2026-10-28)

- Settings: the base URL and the notes on the system-wide AI settings are not wider on a large display than on a small one (repository checker E5509)

### 0.5.1 (2026-10-28)

- Timers of the adapter instead of the ones of Node.js (repository checker E5005)

### 0.5.0 (2026-10-28)

- The system-wide AI settings of admin (System settings, tab "AI") can be used: new key source; an instance without a key of its own takes them too
- Google Gemini and OpenRouter as providers (OpenRouter: one key for the models of many vendors, model IDs as `vendor/model`)
- sendTo `ask` accepts `conversation` and `instructions`: a conversation of its own per caller conversation, e.g. one per room of a voice assistant
- The three points above by GermanBluefox; an instance updated from 0.2.0 or older keeps its own key
- Admin chat: switch "Details" with the tool calls, their results and times, and the tokens of every request
- Admin chat: administrators can read the other conversations (messengers, other admin users, ioBroker.assistant)
- Admin chat: "New conversation" deletes the old conversation from the store at the next start (after a safety copy)

### 0.4.0 (2026-10-28)

- Tab "Backup": backups of the conversations by hand and automatic (daily or weekly) in the storage folder, which
  the ioBroker backup (BackItUp) contains; restore with a safety copy
- Copy of every backup to an external server over SFTP, and restore from it

### 0.3.0 (2026-10-28)

- OpenAI-compatible servers with an own base URL (Ollama, LM Studio, vLLM, Groq, OpenRouter, ...)
- The API key can come from the central credential store of admin 8; a changed credential restarts the instance
- Button "Test connection" in the settings
- Time zone: a list of all time zones with their UTC offset
- Requires admin 8.0.0 or newer

### 0.2.0 (2026-10-26)

- Chat in the admin: the menu entry "Pi Agent" opens a chat with the agent, one conversation per ioBroker user, with tool calls, confirmation buttons and reminders

### 0.1.0 (2026-10-26)

- Messengers: a table with one row per bot (active, instance, allowed users, prefix), for several Telegram instances and the MAX messenger (adapter `max`); the Telegram settings of 0.0.5 are moved into it at the first start
- Confirmations and reminders go back through the bot the request came from
- Allowed users can be separated by commas
- Write permissions: a table of scopes (instance, object ID or pattern with `*`) with the checkboxes "Write allowed" and "Confirmation required", and a button that adds the installed instances; the regular expressions stay under "Advanced"
- The settings have three tabs: General, Write permissions, Messengers
- "Dry run" is now called "Simulation mode (nothing is switched)"

### 0.0.5 (2026-10-26)

- Model field: a list of the models of the chosen provider, a model ID can still be typed in
- Fix: sendTo (e.g. `ask` from scripts, the model list) never reached the adapter, because `supportedMessages: {custom: false}` switched the message box off; the outdated key is removed from the instance at the first start, which restarts the instance once

### 0.0.4 (2026-10-26)

- Writes can require a confirmation with buttons in Telegram ("Confirmation required")
- New tool `remind_me`: reminders that survive restarts
- New tool `get_history`: past values from the history, sql or influxdb instance
- Token use and cost in `usage.*`
- Time zone setting: `remind_me` reads local times ("18:00", "27.10. 18:00"), answers and history are in local time, new tool `get_time`

### 0.0.3 (2026-10-26)

- Conversations are stored in SQLite instead of JSONL, which kept the whole history in memory
- Every conversation has its own queue: Telegram chats no longer wait for each other
- An answer that would give broken HTML is sent to Telegram as plain text; a quote in a link URL is escaped

### 0.0.2 (2026-10-25)

- Telegram answers keep their formatting: Markdown of the model is sent as Telegram HTML (bold, italic, code, links;
  tables as a monospace block), and Telegram chats are asked for short answers without tables
- Released through the CI workflow with npm provenance (trusted publishing)

### 0.0.1 (2026-10-25)

- Initial version: durable agent with the tools `search_objects`, `get_state`, `list_instances` and `set_state`
- Write allowlist and simulation mode; an interrupted write is never repeated; requests continue after a restart
- Telegram: talk to the agent through a telegram instance, with allowed users, prefix and one conversation per chat
- Providers: Anthropic, OpenAI, DeepSeek; every tool call is logged
