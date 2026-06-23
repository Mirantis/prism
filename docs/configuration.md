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

`AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID` only matter on the **first** boot
with an empty database; later boots reuse the stored workspace.

## Models

| Variable | Purpose | Default |
|----------|---------|---------|
| `BEDROCK_MODEL_ID` | Main model (the agent's reasoning loop) | `us.anthropic.claude-opus-4-8` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | Fast model for the [heartbeat](heartbeat.md) DELIVER/SUPPRESS gate | a Claude Haiku model |
| `BEDROCK_EMBEDDING_MODEL_ID` | Embedding model for [searchable memory](memory.md) | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |

The main model can also be set per-agent at runtime (Web UI Profile, the TUI
`/model` command, or by asking the agent), which overrides the default.

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
