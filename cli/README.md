# prism

The terminal UI for Prism Agent, a Rust binary. It talks to an `agent-runtime`
over WebSocket and REST. There is no auth — the CLI is intended for
local-dev only.

## Quickstart

```bash
# 1. Start an agent-runtime (defaults DATABASE_URL to file:./agent.db,
#    runs a build first).
npm start

# 2. In another terminal, start the CLI.
npm run dev:tui
```

The runtime owns the `agentId` / `userId` server-side; the CLI sends
chat envelopes without them.

## Configuration

Display preferences live in `~/.prism/settings.json`. Every key is optional;
missing or malformed config falls back silently to the bundled defaults.

```json
{
  "agentName": "Prism",
  "modelId": "global.anthropic.claude-opus-5",
  "heartbeatModelId": "global.anthropic.claude-haiku-5-5",
  "cronModelId": "global.anthropic.claude-sonnet-4-6",
  "hideCursor": false,
  "hideStatusBar": false,
  "httpUrl": "http://localhost:3003"
}
```

| Key                | Type    | Default                          | Purpose                                                              |
| ------------------ | ------- | -------------------------------- | -------------------------------------------------------------------- |
| `agentName`        | string  | `Prism`                          | Display name in the chat prefix and header.                          |
| `modelId`          | string  | `global.anthropic.claude-opus-5`   | Status-bar display, and the main-model default a fresh agent is bootstrapped with. |
| `heartbeatModelId` | string  | _(unset)_                        | Heartbeat-model default a fresh agent is bootstrapped with. Empty → falls back to the main model. |
| `cronModelId`      | string  | _(unset)_                        | Scheduled-task-model default a fresh agent is bootstrapped with. Empty → falls back to the main model. |
| `hideCursor`       | boolean | `false`                          | Hide the input cursor (a11y).                                        |
| `hideStatusBar`    | boolean | `false`                          | Hide the bottom status bar (a11y).                                   |
| `httpUrl`          | string  | `http://localhost:3003`          | Agent-runtime base URL. WebSocket URL is derived (`/api/ws`, ws/wss). |

`modelId`, `heartbeatModelId`, and `cronModelId` are read by the agent-runtime
(which shares `~/.prism/`) when it **first bootstraps an agent** — they seed the
agent's model overrides. Changing them later has no effect on an
already-created agent; use the Profile page or the `/model`, `/heartbeat-model`,
and `/cron-model` commands for that.

`PRISM_HTTP_URL` (env) overrides `httpUrl` for ad-hoc runs and test
harnesses that need to point at an ephemeral port without writing to
disk. There is no separate `PRISM_WS_URL`.

## Commands

```bash
# Build and run (arguments after `--` go to prism, e.g. `-- --resume`)
cargo run --manifest-path cli/Cargo.toml --

# The release binary, at cli/target/release/prism
cargo build --release --manifest-path cli/Cargo.toml

# Unit tests
cargo test --manifest-path cli/Cargo.toml
```
