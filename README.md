# muse-discord

On-demand Discord bot tool for an AI agent. Run it per check, it exits when done. Works as a one-shot CLI or an MCP stdio server. Read state (watermarks) lives in SQLite.

## Setup

1. Create a bot in the [Developer Portal](https://discord.com/developers/applications) and turn on **Message Content Intent**.
2. Invite it with the `bot` scope and these permissions: View Channel, Send Messages, Read Message History, Add Reactions.
3. `bun install`

| Env | Required | Default |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | — |
| `DISCORD_MCP_DB` | no | `./data/state.sqlite` (must be inside the working dir) |
| `DISCORD_MCP_DEFAULT_GUILD_ID` | no | `1513823779124416582` |

All files (DB, bun cache) stay inside the project directory.

## Usage

```sh
bun run start help                                    # list tools and options
bun run start whoami
bun run start list_unread --per_channel_limit 20
bun run start mark_read --channel_id 123              # up to latest
bun run start reply_message --channel_id 123 --message_id 456 --content "hi"
bun run start send_message '{"channel_id":"123","content":"hi"}'   # JSON also works
bun run start                                         # no args: MCP stdio server
```

The CLI prints JSON to stdout. Exit code is 0 on success and 1 on error, with `{"error":{"code","message","status"}}`. Logs go to stderr.

Tools: `whoami`, `list_channels`, `list_unread`, `mark_read`, `get_messages`, `send_message`, `reply_message`, `add_reaction`.

## Read flow

1. `list_unread`: on the first run each channel is only initialized (`initialized_channels`) and no backlog is returned. It never advances the watermark.
2. Reply or react.
3. `mark_read` each channel. If `truncated` is true, pass `--up_to_message_id <last returned id>`.

Channels and threads created after the first run are read from their first message.

## Listen (Gateway)

```sh
bun run start listen   # long-running; stop with SIGINT/SIGTERM
```

Stays connected to the Gateway (intents `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT`). For each `MESSAGE_CREATE` in the guild that is not from the bot itself, it appends one JSON line to the spool when the message:

- mentions the bot (`reason: "mention"`)
- mentions the Agent role (`reason: "role_mention"`)
- is in a watched channel, with or without a mention (`reason: "watched_channel"`)

Line format: `{reason, message_id, channel_id, guild_id, author_id, author_name, content (max 500 chars), timestamp, detected_at}`. Logs go to stdout as JSON Lines. Listen mode never touches the SQLite watermarks.

The session and the last 1000 message ids are kept in the state file, so a restart resumes the session and nothing is spooled twice.

| Env | Default |
|---|---|
| `DISCORD_GUILD_ID` | `1513823779124416582` |
| `AGENT_ROLE_ID` | `1567703605514084353` |
| `WAKE_CHANNEL_IDS` | `1567704255312429208` (comma-separated) |
| `WAKE_SPOOL_PATH` | `./data/wake-events.jsonl` |
| `LISTEN_STATE_PATH` | `./data/listen-state.json` |

## Test

```sh
bun run test   # E2E against a local fake Discord, no network
```
