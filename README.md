# Prism

> Standalone agent runtime: long-lived AI agents with persistent memory,
> scheduled work, heartbeat checks, and Slack/WebSocket chat — running
> in a single container.

## What Prism is

Prism is a self-contained AI agent. One container, one embedded database, no
external services. State, conversation flow, scheduled work, channel adapters,
and tool execution all run in-process. The only hard runtime dependency is an
LLM provider.

The agent is not a chatbot session — it persists between conversations,
maintains its own memory, runs heartbeat checks on a schedule, can put work on
its own calendar, and can act over a shell.

## Features

### Conversational interface

Real-time chat over WebSocket and Slack. Supports DMs and channel
conversations and multi-turn threads.

### LLM models

Default models:

- **Main loop**: Claude Opus 4.7
- **Classification gate**: Claude Haiku (fast, deterministic)
- **Embeddings**: Amazon Titan v2

All three are configurable. Prompt caching is built in: the stable parts of
the system prompt — identity, curated memory, vision, operating manual —
cache across turns; only the dynamic parts (timestamps, recalled memories)
re-process.

### Tools the agent can use

Out of the box, the agent has tools for:

- **Memory** — search, write, delete entries in its long-term memory store.
- **Self-management** — edit its own personality, the profile of its user,
  its curated memory, vision, operating manual, heartbeat checks, and
  runtime settings, all from inside the conversation.
- **Scheduling** — create, list, run, and delete scheduled tasks using
  natural language (`"in 5 minutes"`, `"every weekday at 9am"`) or raw
  cron expressions.
- **Shell** — run commands, read/write/edit files, spawn long-running
  processes, manage their I/O, and invoke Claude Code as a sub-agent.

### Memory

Two layers, both persisted in the embedded database:

1. **Curated memory** — a markdown summary the agent maintains itself, always
   present in its system prompt. Bounded, durable, low-latency recall of the
   things the agent has decided are worth keeping permanently.
2. **Searchable memory** — an embedding-indexed store for everything else,
   queryable by meaning rather than keyword. Embeddings come from Bedrock
   Titan v2; vector search runs on the embedded SQLite database.

### The agent's "self"

Each agent is defined by a small set of markdown documents:

| Document | Purpose | Edited by |
|----------|---------|-----------|
| **Soul** | Personality, values, boundaries | User |
| **User** | What the agent knows about the person it's working for | Agent |
| **Memory** | Curated long-term knowledge | Agent |
| **Vision** | The user's goals for the agent | User |
| **Agent guide** | The operating manual the agent follows | User |
| **Heartbeat** | The checks the agent performs on its schedule | User |
| **Bootstrap** | First-run onboarding instructions, cleared once complete | Agent |

Together they form the agent's identity — change them and the agent changes.

### Heartbeat

An always-on monitoring loop. Default cadence is every 8 hours, configurable
per agent. On each tick, the agent runs the checks defined in its heartbeat
document, then a fast classification model (Haiku) decides whether the result
is worth bothering the user with — DELIVER or SUPPRESS. Identical alerts
within 24 hours are suppressed by full-text comparison, so the agent doesn't
re-page on the same finding.

Heartbeats can also be **Slack-triggered**: messages in designated trigger
channels queue, and incoming traffic wakes the heartbeat between scheduled
runs. Pending messages are drained atomically so no message is orphaned, even
if multiple arrive while the agent is busy.

### Scheduled tasks

The agent puts work on its own calendar. Tasks can be one-shot or recurring,
specified in natural language or cron syntax, and survive restarts. One-shot
tasks delete themselves after running; recurring tasks track their last run,
their next run, and consecutive errors. The agent can list, run-now, or
cancel its own tasks.

### Sessions and idle handling

A configurable daily reset (default 4 AM local time) and idle timeouts give
the agent a clean break between logical "days." This keeps long-running
context from compounding indefinitely.

### Safety controls

- **Step limit** — at most 100 tool-use steps per turn. When the agent hits
  the cap, a tool-less follow-up call asks it to summarize what it found
  rather than spinning further.
- **Output cap** — 16,000 tokens per generation.
- **Per-tool output limits** — large tool responses are truncated before
  reaching the model, so a single tool call can't flood context.
- **Heartbeat classification gate** — programmatic checks (empty response,
  exact 24-hour duplicate) run first; the LLM gate only runs if those pass;
  if the gate itself errors, the message is delivered (fail-open).

### Observability

- **Structured logs** by default (Pino).
- **Langfuse tracing** for every LLM call — model, tokens, tool calls,
  latency. Enabled by setting Langfuse keys; disabled otherwise.
- **OpenTelemetry log export** to a configured collector. Disabled when no
  endpoint is set.

## How it runs

One container, one agent. The embedded database (SQLite with vector search)
lives in the container at `/data/agent.db` and is the only persistence.

## Getting started

### Local development

```bash
npm install
SINGLE_AGENT_MODE=true \
NEXUS_PROJECT_ID=<project-uuid> \
AWS_BEARER_TOKEN_BEDROCK=<bedrock-key> \
npm run dev
```

`NEXUS_PROJECT_ID` is the Nexus project this agent lives in; it's used to
authorize WebSocket chat against Nexus. `NEXUS_URL` defaults to
`http://localhost:3002` — override it if Nexus is reachable at a different
address.

The runtime listens on port `3003`. Health check:

```bash
curl http://localhost:3003/health
```

On first boot with an empty database, Prism auto-creates the agent workspace
using `AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID`. Subsequent boots find
the existing workspace and reuse it.

### Docker

```bash
docker build -t prism .
docker run -p 3003:3003 \
  -v prism-data:/data \
  -e SINGLE_AGENT_MODE=true \
  -e NEXUS_PROJECT_ID=<project-uuid> \
  -e AWS_BEARER_TOKEN_BEDROCK=<bedrock-key> \
  prism
```

Mount a volume at `/data` so the agent's database survives container
restarts.

## Configuration

### Required

| Variable | Purpose |
|----------|---------|
| `SINGLE_AGENT_MODE` | Set to `true` to run as a standalone agent |
| `NEXUS_PROJECT_ID` | Nexus project this agent lives in. Used to authorize WebSocket chat — callers must have access to this project in Nexus. Startup fails if unset |

### Credentials

| Variable | Purpose |
|----------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key. The AI SDK auto-selects bearer auth when this is set |
| `SLACK_BOT_TOKEN` | Slack bot token. Validated via `auth.test` on boot when set |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode |

### Optional

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port | `3003` |
| `DATABASE_URL` | SQLite path | `file:/data/agent.db` |
| `AGENT_ID` | Pin the agent's UUID. When unset, a fresh UUID is generated on first boot and reused on subsequent boots via the workspace row in the DB | generated |
| `NEXUS_URL` | Base URL of the Nexus instance used for WebSocket authorization and the MCP/LLM proxy | `http://localhost:3002` |
| `AGENT_NAME` | Display name on first boot | `Prism` |
| `TEAM_NAME` | Team name on first boot | `Local` |
| `OWNER_USER_ID` | Owner user ID on first boot. The default is a local sentinel — Slack identity linking later overlays the real `lensUserId` per-message | `00000000-0000-0000-0000-000000000001` |
| `BEDROCK_MODEL_ID` | Main model | `us.anthropic.claude-opus-4-7` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | Heartbeat gate model | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_EMBEDDING_MODEL_ID` | Embedding model | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | AWS region | `us-east-1` |
| `SLACK_EXPECTED_APP_ID` | Optional safety check on the Slack app identity | — |
| `LANGFUSE_SECRET_KEY` | Enables Langfuse tracing when set | — |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — |
| `LANGFUSE_BASE_URL` | Langfuse server | `http://localhost:3100` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables OpenTelemetry log export | — |
| `OTEL_EXPORTER_OTLP_API_KEY` | API key sent as `x-api-key` to the collector | — |

## Interfaces

Prism exposes the following surfaces:

- **WebUI** — a built-in browser UI served by the runtime. Chat with the
  agent, browse threads, view and edit the agent's workspace files
  (soul, memory, vision, agent guide, heartbeat), inspect scheduled tasks,
  and watch heartbeat history. Available on the same port as the runtime.
- **TUI** — a terminal UI for chatting with the agent and managing its
  state from the shell. Useful for headless servers and SSH sessions, and
  the natural fit when running Prism alongside jahe-CLI.
- **WebSocket** — real-time chat for a UI or CLI. Streamed responses,
  status updates, and tool-call events.
- **Slack** — runs in Socket Mode. Once the agent's Slack workspace is wired
  up, DMs and channel mentions reach the agent directly without a public
  webhook. Six-character verification codes link Slack identities to the
  agent's user.
- **Management API** — REST endpoints for agent lifecycle, scheduling,
  thread management, and Slack mappings. Useful for building a UI or driving
  Prism from a control plane.
- **Health endpoint** — `GET /health` for orchestrators.

## Development

| Command | What it does |
|---------|--------------|
| `npm install` | Install dependencies and generate the database client |
| `npm run dev` | Start in watch mode (auto-restart on changes) |
| `npm run build` | TypeScript compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite in watch mode |
| `npm run test:run` | Single test run |
| `npm run test:coverage` | Coverage report |
| `npm run test:single-agent` | Tests in single-agent mode |
| `npm run db:migrate` | Apply database migrations |
| `npm run prisma:generate` | Regenerate the database client |
