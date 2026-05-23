# prism-cli

Standalone Ink-based terminal UI for Prism. Talks to an `agent-runtime`
over WebSocket and REST. There is no auth — the CLI is intended for
local-dev only.

## Quickstart

```bash
# 1. Start an agent-runtime (defaults DATABASE_URL to file:./agent.db,
#    runs a build first).
npm start

# 2. In another terminal, start the CLI.
npm run dev --workspace=prism-cli
```

The runtime owns the `agentId` / `userId` server-side; the CLI sends
chat envelopes without them.

## Configuration

Display preferences live in `~/.prism/settings.json`. Every key is optional;
missing or malformed config falls back silently to the bundled defaults.

```json
{
  "agentName": "Prism",
  "modelId": "us.anthropic.claude-opus-4-7",
  "hideCursor": false,
  "hideStatusBar": false,
  "httpUrl": "http://localhost:3003"
}
```

| Key             | Type    | Default                          | Purpose                                                              |
| --------------- | ------- | -------------------------------- | -------------------------------------------------------------------- |
| `agentName`     | string  | `Prism`                          | Display name in the chat prefix and header.                          |
| `modelId`       | string  | `us.anthropic.claude-opus-4-7`   | Display only — pretty-printed in the status bar.                     |
| `hideCursor`    | boolean | `false`                          | Hide the input cursor (a11y).                                        |
| `hideStatusBar` | boolean | `false`                          | Hide the bottom status bar (a11y).                                   |
| `httpUrl`       | string  | `http://localhost:3003`          | Agent-runtime base URL. WebSocket URL is derived (`/api/ws`, ws/wss). |

`PRISM_HTTP_URL` (env) overrides `httpUrl` for ad-hoc runs and test
harnesses that need to point at an ephemeral port without writing to
disk. There is no separate `PRISM_WS_URL`.

## Commands

```bash
# Run in dev (no build step, via tsx)
npm run dev --workspace=prism-cli

# Compile to dist/
npm run build --workspace=prism-cli

# Run the compiled output
npm run start --workspace=prism-cli
```

After `npm run build`, the `dist/index.js` is the CLI entry point and the
`bin` field exposes it as `prism`, so a global `npm link` makes it
runnable as `prism` on PATH.
