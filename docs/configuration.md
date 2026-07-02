# Configuration

The runtime is configured entirely through environment variables. For a native
install they go in `~/.prism/.env` (restart the service after editing); for
Docker, pass them with `-e`. Only an LLM credential is required — everything
else has a sensible default.

## Credentials

| Variable | Purpose |
|----------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key. The AI SDK auto-selects bearer auth when this is set. This is the one credential required for chat. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS SigV4 credentials, as an alternative to the bearer token. |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Enables the Slack adapter; validated via `auth.test` on boot. |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`) for Socket Mode. |
| `SLACK_EXPECTED_APP_ID` | Optional safety check — the bot token's app ID must match this if set. |

See **[Slack](slack.md)** for how the tokens are used.

## Core

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port the runtime listens on | `3003` |
| `DATABASE_URL` | SQLite URL for the agent database. The Docker image's `start.sh` sets this to `file:/data/agent.db`; locally it resolves next to the Prisma schema. | `file:/data/agent.db` (Docker) |
| `AGENT_ID` | Pin the agent's UUID. Unset → a fresh UUID is generated on first boot and reused thereafter. | generated |
| `AGENT_NAME` | Display name on first boot | `Prism` |
| `TEAM_NAME` | Team name on first boot | `Local` |
| `OWNER_USER_ID` | Owner user ID on first boot | local sentinel UUID |
| `SHELL_WORKSPACE_ROOT` | Working directory for the agent's [shell tools](tools.md#shell) | install `workspace` dir (Docker: `/home/node`) |
| `PRISM_DATA_DIR` | Persistent data dir for [skills](skills.md) and the Claude Code config. The Docker image sets this to the `/data` volume. | `/data` (Docker), else `~/.prism` |
| `PRISM_SKILLS_DIR` | Override the [skills](skills.md) directory specifically. | `<data dir>/skills` |

`AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID` only matter on the **first** boot
with an empty database; later boots reuse the stored workspace.

[Webhooks](webhooks.md) need no environment variables — the receiver toggle and
subscriptions live in the database, managed from the Web UI. Note that the
runtime does not authenticate inbound webhook calls itself (auth is the
platform's job in front of the container), so don't expose the runtime port
directly to the internet.

## Models

| Variable | Purpose | Default |
|----------|---------|---------|
| `BEDROCK_MODEL_ID` | Main model (the agent's reasoning loop) | `us.anthropic.claude-opus-4-8` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | Fast model for the [heartbeat](heartbeat.md) DELIVER/SUPPRESS gate | a Claude Haiku model |
| `BEDROCK_EMBEDDING_MODEL_ID` | Embedding model for [searchable memory](memory.md) | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |

The main model can also be set per-agent at runtime (Web UI Profile, the TUI
`/model` command, or by asking the agent), which overrides `BEDROCK_MODEL_ID`.

**Heartbeat and scheduled (cron) runs** can each use their own model, set the
same ways — the Web UI Profile page or the TUI `/heartbeat-model` /
`/cron-model` commands. Both default to empty and fall back to the main model
(which in turn falls back to `BEDROCK_MODEL_ID`), so you can, for example, run
routine heartbeats on a cheaper model while chat stays on a stronger one. The
heartbeat DELIVER/SUPPRESS gate always uses `BEDROCK_CLASSIFICATION_MODEL_ID`,
independent of this.

### Bootstrap model defaults (`~/.prism/settings.json`)

When the runtime **first creates an agent** (empty database), it seeds the three
model overrides from `~/.prism/settings.json` if present — the same file the
[`prism` TUI](cli-reference.md#settings-file) reads:

| Key | Seeds |
|-----|-------|
| `modelId` | the main model |
| `heartbeatModelId` | the heartbeat model |
| `cronModelId` | the scheduled-task model |

Each is optional; an unset, blank, or malformed value leaves that override empty
(and it falls back as above). These apply **only at creation** — editing them
later doesn't touch an existing agent; use the Profile page or the TUI commands
for that.

## Integrations

| Variable | Purpose | Default |
|----------|---------|---------|
| `NEXUS_MCP_URL` | Endpoint of an external [MCP server](tools.md#external-tools-mcp). When set, its tools are exposed to the agent. | — (no external tools) |
| `NEXUS_API_URL` | Base URL of a Nexus instance, used for the LLM proxy and WebSocket authorization. It is **not** a fallback for `NEXUS_MCP_URL`. | — |

## Observability

All optional; each is off until its variable is set. Langfuse traces every LLM
call (model, tokens, tool calls, latency); OpenTelemetry exports product
telemetry to a collector. Structured logs (Pino) are always on.

| Variable | Purpose | Default |
|----------|---------|---------|
| `LANGFUSE_SECRET_KEY` | Enables Langfuse LLM tracing when set | — |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — |
| `LANGFUSE_BASE_URL` | Langfuse server URL | `http://localhost:3100` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables OpenTelemetry export when set | — |
| `OTEL_EXPORTER_OTLP_API_KEY` | Collector auth, sent as `x-api-key` | — |
| `DEPLOYMENT_ENVIRONMENT` | Tags OTel records (`production` / `staging` / `development`) | `production` (published images) |

## Installer variables

These affect the native [installer](installation.md), not the running agent:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PRISM_HOME` | Install directory | `~/.prism` (`%USERPROFILE%\.prism`) |
| `PRISM_HTTP_URL` | Runtime URL the [`prism` TUI](cli-reference.md) connects to | `http://localhost:3003` |
