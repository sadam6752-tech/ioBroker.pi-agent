# Older Changelog

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
