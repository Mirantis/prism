# Agent Runtime

Self-sufficient LLM invocation service that owns the full agent execution lifecycle.
Builds agent context locally (agent data and conversation history from
its own database), connects to MCP servers for tools, runs heartbeat and cron
scheduling in-process, manages Slack connections via Bolt SDK with Socket Mode,
runs the conversation engine and message delivery locally, and delivers results
directly to users via local channel adapters (WebSocket, Slack).

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Every commit subject must use the `<type>(<scope>): <description>` form —
common types are `feat`, `fix`, `refactor`, `ci`, `docs`, `chore`, and `test`.

Every commit must be signed off (DCO): commit with `git commit -s` so a
`Signed-off-by: Name <email>` trailer is added.

When a PR branch conflicts with `main`, resolve by rebasing the branch
onto `main` (`git rebase origin/main`, then force-push) — never with a
merge commit. PR branches stay merge-commit-free.

## PR descriptions

The Test plan section should describe behavior that was actually exercised
(local smoke runs, manual UI walks, specific commands, etc.). Never list
"`<workflow>.yml` green" as a Test plan item — every workflow that gates
the PR is already a required check on the PR page, so it's self-evident
and adds noise.

## Testing

Every new **user-facing feature must ship with comprehensive end-to-end
tests** covering each surface it touches — exercise the real flow, not just
unit-level mocks. The e2e suites live in `e2e/`:

- **Web**: Playwright BDD — a `.feature` in `e2e/features/` with step
  definitions in `e2e/steps/` driving the SPA against a real agent-runtime
  and real Bedrock. Run via `npm run test --workspace=prism-agent-e2e`.
- **CLI/TUI**: Gherkin `.feature` files in `e2e/tui/features/` bound with
  `@amiceli/vitest-cucumber` (runs on vitest) in `e2e/tui/tests/`, driving
  `prism-cli` under a `node-pty` PTY against a real runtime. The runtime + PTY
  lifecycle is wired through the `BeforeAllScenarios`/`BeforeEachScenario`/
  `AfterEachScenario`/`AfterAllScenarios` hooks; shared steps go through
  `defineSteps`. Run via `npm run test:e2e:tui --workspace=prism-agent-e2e`.

A feature that spans both web and CLI needs e2e coverage on both. Assert on
authoritative state where possible (downloaded file bytes, DB rows via the
management API) rather than only on-screen text. Both suites need Node 24+
and AWS/Bedrock credentials in the shell (see `e2e/README.md`).

## Telemetry

Every new **user-facing feature must also emit product telemetry** for its key
lifecycle events via `trackEvent(name, userId, props)` (`lib/telemetry.ts`).
Cover at least creation and terminal outcomes (success + failure/error paths) so
the feature is observable in production. Rules:

- **One owning emitter per event** — callers delegate, never re-emit (a duplicate
  count silently corrupts the metric). Keep events lean.
- **No PII in props** — never include free-text user content (e.g. a goal
  objective, message body, file contents). Emit ids, statuses, counts, and
  durations (e.g. `goal.turns`, `goal.elapsed_ms`) instead.
- Mirror the lifecycle shape of existing features: e.g. goals emit
  `goal started` (creation) and `goal finished` (with `status`, `turns`,
  `elapsed_ms`); cron emits `cron task scheduled` / `cron task executed`.

## Documentation

Any **user-facing change must update the docs** in the same PR. The user docs
live in `docs/` (see `docs/README.md` for the layout): installation, the web
and terminal UIs, Slack, and a page per feature, plus the configuration and CLI
reference. When you add, change, or remove a feature, flag, env var, command,
slash command, or UI surface, update the relevant doc page (and the root
`README.md` if it covers the same thing) so the docs never drift from behavior.

## Code conventions

- **One component per file.** Each React (`web/`) and Ink (`cli/`) component
  lives in its own file named for the component (kebab-case, e.g.
  `model-field.tsx`), not several components sharing a module. A component's
  small private helpers may stay in its file; shared ones move to a module.

## Deployment shape

One `AGENT_ID` per container, embedded SQLite + sqlite-vec at
`file:/data/agent.db`. Slack creds come from env (`SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`), validated via `auth.test` on boot; may be Nexus
credential sentinels (`__nexus_cred:<uuid>__`) rewritten by the MITM
proxy. Bedrock via Bearer API key (`AWS_BEARER_TOKEN_BEDROCK`) — the
SDK auto-selects Bearer over SigV4 when set.

## SEA binaries — Node 22 pin

The `prism` / `prism-server` SEA build (workflows: `create-binary.yml`,
called from `release-deploy.yml`) is pinned to **Node 22**. Don't bump it
to 23+ without refactoring the bundle loader.

Why: `scripts/build-sea.mjs` generates a CJS stub that extracts the ESM
bundle (which contains top-level await from ink + yoga + the AI/AWS SDKs,
hence can't be CJS) to a temp file and dynamic-imports it. From Node 23+
this throws `ERR_UNKNOWN_BUILTIN_MODULE` — the documented behaviour per
the [Node SEA docs](https://nodejs.org/api/single-executable-applications.html):

> Attempting to use `import()` to load modules from the file system will
> throw an error.

Node 22 falls through to the regular ESM loader for file URLs and
happens to work; Node 23+ enforces the ban. `module.createRequire()`
isn't a workaround for us because `require()` of an ESM bundle with
top-level await fails `ERR_REQUIRE_ASYNC_MODULE`. Lifting the pin needs
rewriting external imports as `createRequire(execPath)` calls (likely an
esbuild plugin) and switching the SEA config to `mainFormat: "module"`.

## Local development

The recommended local dev loop for **all** agent-runtime work — services,
MCP tools, prompts, conversation engine, heartbeats, cron, Slack adapter,
WS gateway, and the bundled Web UI under `web/` — is `tsx watch` against an
embedded SQLite file, with optional Vite for UI HMR.

```bash
# First time only:
cp .env.example .env
$EDITOR .env                          # uncomment DATABASE_URL

# Every time:
npm run dev:single
# → runtime on :3003 (tsx watch), Vite on :5173 (HMR + proxy)
```

`dev:single` applies pending Prisma migrations to SQLite before
launching tsx-watch + Vite concurrently. You never run migrate manually.
The SQLite `DATABASE_URL` comes from `.env`, which the runtime auto-loads
via dotenv.

Browser → `http://localhost:5173`. UI edits hot-reload in <1s, runtime
TypeScript edits restart the server in ~1s. The Vite proxy forwards `/agents`
and `/api/ws` to `:3003` so the SPA code doesn't know it's not hitting the
same origin.

The runtime auto-loads `.env` via dotenv. Slack and Bedrock are optional —
`lib/slack-config.ts` and `lib/bedrock-provider.ts` fail-open when their
tokens are unset. The SPA shell, navigation, profile, `/agents/me`,
`/agents/:id/details`, `/agents/:id/cron-tasks` work with zero extra env. Add
`AWS_BEARER_TOKEN_BEDROCK` (or AWS SigV4) in `.env` for chat;
`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` for Slack flows. See `.env.example`
for the full env block.

### Runtime code changes

`tsx watch` restarts on every save (~1s).

### Production-shape preview (no HMR, no Vite)

Skip the image rebuild while still hitting `:3003` directly: volume-mount
`web/dist` into the running container.

```bash
docker run -d --name prism-smoke \
  -v /tmp/agent-data:/data \
  -v "$PWD/web/dist:/app/web/dist:ro" \
  -p 3003:3003 \
  -e AGENT_ID="$(uuidgen)" \
  prism-agent:latest
```

Then `npm run build --workspace=prism-agent-web` on the host updates the
bundle in place; refresh `:3003` to see it. Useful for catching anything
Vite-proxy-shaped that would mask a real bug.

## Principles

- **Self-sufficient** - Builds its own context locally: reads agent data and conversation history directly from its own embedded SQLite database.
- **Owns conversation engine** - Runs `ConversationEngineService` locally: manages chat flow, thread management, and iterates `invokeStream()` directly (no HTTP, no queue) so each step is delivered as it arrives.
- **Owns message delivery** - Runs `MessageDeliveryService` locally: stores messages via `conversationService` and delivers via local adapters. User-initiated messages deliver only to the originating channel; autonomous messages (heartbeat/cron) broadcast to all connected channels.
- **Owns channel adapters** - WebSocket and Slack adapters run locally, registered with `messageDeliveryService` in `index.ts`.
- **Owns scheduling** - Heartbeat timers and cron jobs run in-process (not in the backend).
- **Owns Slack connections** - Runs Bolt apps with Socket Mode, receives and routes messages, handles verification codes, calls Slack APIs directly. The one connection is synthesized from `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` env vars (validated via `auth.test` on boot; see `lib/slack-config.ts`). Bot token in env may be a Nexus credential sentinel that the MITM proxy rewrites on the wire; a `SlackWebClient` subclass (`lib/slack-web-client.ts`) strips the body `token` field so auth flows only via the `Authorization` header.
- **Owns agent data** - Agent CRUD, ownership validation, nexus token management, and subagent relationships via `agentWorkspaceService` (direct Prisma access). `CreateAgentInput` requires a pre-generated `id` field -- the backend generates the UUID and passes it when creating the `AgentWorkspace`. Note: `orgId` and `teamId` are NOT in `AgentWorkspace` -- they live exclusively in the backend-only `Agent` table.
- **Direct database access** - Has its own Prisma client (SQLite) for agent data (CRUD, ownership, subagents), conversation data (threads, messages, active thread resolution), agent field updates (heartbeat timestamp, heartbeat status), cron task state (list, update run timestamps, delete one-shot tasks), Slack message queue drain (pending heartbeat trigger messages), and Slack mapping CRUD. Vector search over `memory_entries.embedding` goes through a sibling `better-sqlite3` handle that loads the `sqlite-vec` extension (see `lib/sqlite-bootstrap.ts`).
- **No direct imports from backend** - Communicates via HTTP and MCP only.
- **SOLID** - Each service (heartbeat, cron, invoke, conversation engine, message delivery) has a single responsibility.

## Architecture

### Communication with Backend

**Single-agent mode short-circuits this entire section.** No backend
HTTP calls, no management API, no internal API secret. The container
owns one `AgentWorkspace` (identified by `AGENT_ID` env), reads Slack
connection from env, and all "Communication with Backend" flows below
are unused.

Multi-tenant (default) communicates through the following channels:

1. **Internal REST API** (`/internal/api/*`) - Agent-runtime calls backend for:
   - Access control checks via `POST /internal/api/can-access-agent` (backend has Nexus client)
   - SlackConnection read-only access via `/internal/api/slack-connections` (list active, get by ID)

2. **Runtime Database** (PostgreSQL via Prisma) - Agent-runtime reads/writes directly for:
   - **Agent CRUD** (create, delete, list, lookup, ownership validation, subagents) via `agentWorkspaceService`
   - Conversation history (thread context, recent messages)
   - Active thread resolution
   - Thread and message CRUD
   - Agent field updates (heartbeat timestamp, heartbeat status)
   - Cron task state (list active tasks, update run timestamps, delete one-shot tasks)
   - Slack message queue drain (pending heartbeat trigger messages)

3. **Management API** (`/agents/*`) - Backend calls agent-runtime to:
   - **Agent CRUD**: create (`POST /`, receives pre-generated `id` from backend), delete (`DELETE /:agentId`), get details, validate ownership, nexus token get/set, subagent add/remove/list
   - Chat: `POST /agents/chat` (internal/debug use)
   - Start/stop/trigger heartbeat timers
   - Notify of pending Slack messages (`POST /:agentId/heartbeat/slack-trigger`, no body)
   - Schedule/unschedule cron jobs
   - Query heartbeat status
   - CRUD for slack heartbeat triggers (get, create, update throttle, delete, claim, channel check)
   - Get or create active thread (`POST /agents/threads/get-or-create-active`)
   - List threads for user+agent (`GET /agents/threads`)
   - Fetch thread with messages (`GET /agents/threads/:threadId`)
   - Add message to thread (`POST /agents/threads/:threadId/messages`)
   - Deactivate a thread (`POST /agents/threads/:threadId/archive`, sets status to NON_ACTIVE)
   - Get or create thread by external ID (`POST /agents/threads/get-or-create-by-external-id`)
   - Set external thread ID (`POST /agents/threads/:threadId/set-external-id`)
   - Verify Slack DM link codes (`POST /agents/slack/verify-link-code`)
   - Verify Slack channel link codes (`POST /agents/slack/verify-channel-link-code`)
   - Create Slack verification codes (`POST /agents/slack/create-verification-code`)
   - Slack connection management: add-connection, remove-connection, list connections, get channel name
   - Slack mapping queries: link status (`GET /:agentId/slack-link-status`), channel mappings (`GET /:agentId/slack-channel-mappings`), specific channel mapping (`GET /slack/channel-mapping/:channelId`), connection ID lookup (`GET /:agentId/slack-connection-id`)
   - Slack mapping mutations: delete channel mapping (`DELETE /slack/channel-mapping/:channelId`), delete DM mapping (`DELETE /:agentId/slack/dm-mapping`)

### MCP Tool Servers

The runtime hosts one MCP server and connects to another externally:

1. **Internal MCP** (`/internal/mcp`) - memory, config, cron tools (served in-process by agent-runtime)
2. **Nexus MCP** - kubectl, GitHub, AWS tools (external)

## Key Services

| Service | File | Purpose |
|---------|------|---------|
| **invokeStream** | `invoke.ts` | Streaming primitive: builds context, collects tools, calls `generateText()` with step limit and early stopping, yields each `InvokeStep` as `onStepFinish` fires. Errors are yielded as friendly steps (via `buildErrorStep`) rather than thrown. Bridges the SDK's push-based callback into async iteration via `utils/async-channel.ts`. |
| **invoke** | `invoke.ts` | Thin aggregating wrapper around `invokeStream()`: drains the step stream into a single `InvokeResponse`. Used by callers that need the full result before acting (heartbeat, cron, subagent/task tool). |
| **ConversationEngineService** | `services/conversation-engine.service.ts` | Chat flow orchestration: thread management, iterates `invokeStream()` directly and publishes each text-bearing step the moment it arrives, delivers via local `messageDeliveryService` |
| **MessageDeliveryService** | `services/message-delivery.service.ts` | Unified message publish: stores via `conversationService`, delivers via channel adapters (channel-scoped for user messages, broadcast for autonomous) |
| **ContextService** | `services/context.service.ts` | Builds agent context from local database: agent data via `agentWorkspaceService.getAgentById()` and conversation history via Prisma |
| **ConversationService** | `services/conversation.service.ts` | Thread and message CRUD via Prisma, pluggable thread providers (database + Slack) |
| **AgentWorkspaceService** | `services/agent-workspace.service.ts` | Agent CRUD, ownership validation, nexus token management, subagent relationships |
| **AgentStatusService** | `services/agent-status.service.ts` | Direct Prisma writes for agent fields (heartbeat timestamp, heartbeat status) |
| **HeartbeatService** | `services/heartbeat.service.ts` | Always-on monitoring loop with in-process timers, full-text duplicate suppression, Slack-triggered heartbeats |
| **CronSchedulerService** | `services/cron-scheduler.service.ts` | Scheduled task execution using node-cron and setTimeout; manages cron task state directly via Prisma (list, update run timestamps, delete) |
| **SlackAdapterService** | `services/slack-adapter.service.ts` | Full Slack implementation: Bolt apps, Socket Mode, message handling, verification codes |
| **SlackMappingService** | `services/slack-mapping.service.ts` | SlackMapping CRUD for user and channel mappings via Prisma |
| **SlackMessageQueueService** | `services/slack-message-queue.service.ts` | Direct Prisma drain of pending Slack messages for heartbeat triggers |
| **SlackHeartbeatTriggerService** | `services/slack-heartbeat-trigger.service.ts` | CRUD for per-agent Slack heartbeat trigger config, atomic claim logic |
| **SessionManagerService** | `services/session-manager.service.ts` | Daily session resets, idle timeout management |
| **MemoryManagerService** | `services/memory-manager.service.ts` | Two-layer memory: daily append-only logs + curated long-term key-value store |
| **MCP Server** | `mcp/server.ts` | Internal MCP server at `/internal/mcp` providing memory, config, and cron tools |
| **WebSocketGatewayService** | `services/websocket-gateway.service.ts` | WebSocket server: JWT decode (backend verifies), connection management, per-user message queuing, agent status management |
| **WebSocketAdapterService** | `services/websocket-adapter.service.ts` | ChannelAdapter for WebSocket delivery, calls local gateway directly |
| **BackendClient** | `lib/backend-client.ts` | Typed HTTP client for backend internal REST API: access control (`canAccessAgent()`) + SlackConnection read-only access (`getActiveSlackConnections()`, `getSlackConnection()`) |

## File Organization

```
src/
├── index.ts                    # Entry point: start server, init heartbeats & cron
├── server.ts                   # Express app: /invoke, /health, /agents/* routes
├── config.ts                   # Centralized env var config
├── invoke.ts                   # Unified LLM invocation: `invokeStream()` (streaming generator) + `invoke()` (drain wrapper)
├── constants.ts                # Shared constants (STEP_LIMIT, MAX_OUTPUT_TOKENS)
├── types.ts                    # Request/response types (ChatRequest, InvokeRequest, InvokeStep with optional InvokeError, etc.)
├── services/
│   ├── conversation-engine.service.ts # Chat flow orchestration: thread mgmt, iterates invokeStream() with per-step publish, local message delivery
│   ├── message-delivery.service.ts # Unified message publish: store + channel-scoped or broadcast delivery
│   ├── agent-workspace.service.ts # Agent CRUD, ownership validation, nexus tokens, subagents
│   ├── agent-status.service.ts  # Direct Prisma writes for agent fields (heartbeat timestamp/status)
│   ├── websocket-gateway.service.ts # WebSocket server: JWT decode (backend verifies), connection mgmt, message queuing
│   ├── websocket-adapter.service.ts # ChannelAdapter for WebSocket, calls local gateway
│   ├── channel-adapter.interface.ts # Channel adapter contract (ChannelAdapter interface)
│   ├── context.service.ts      # Builds agent context (agent data from backend + conversation from DB)
│   ├── conversation.service.ts # Thread/message CRUD via Prisma, pluggable thread providers
│   ├── heartbeat.service.ts    # Heartbeat timer management, execution, and Slack-triggered heartbeats
│   ├── cron-scheduler.service.ts # Cron job scheduling and execution
│   ├── slack-adapter.service.ts   # Full Slack implementation: Bolt apps, Socket Mode, message handling
│   ├── slack-mapping.service.ts   # SlackMapping CRUD for user & channel mappings via Prisma
│   ├── slack-message-queue.service.ts # Direct Prisma drain of pending Slack messages
│   ├── slack-heartbeat-trigger.service.ts # CRUD for per-agent Slack heartbeat trigger config, atomic claim logic
│   ├── session-manager.service.ts # Daily session resets, idle timeout management
│   ├── memory-manager.service.ts  # Two-layer memory system (daily logs + curated key-value store)
│   ├── thread-provider.interface.ts # ThreadMessageProvider abstraction
│   └── providers/
│       ├── database-thread.provider.ts # Default: reads messages from PostgreSQL
│       └── slack-thread.provider.ts    # Slack: reads messages via local Bolt apps (direct Slack API)
├── mcp/
│   ├── auth.ts                 # MCP authentication middleware
│   ├── server.ts               # MCP server setup, mounted at /internal/mcp
│   └── tools/
│       ├── agent-config.mcp.ts # Agent config tools (soul, user, memory, heartbeat, vision, settings)
│       ├── cron.mcp.ts         # Cron task tools (schedule, list, delete)
│       └── memory.mcp.ts       # Memory tools (search, write, delete)
├── routes/
│   └── management.ts           # Management API for backend to push heartbeat/cron/slack-heartbeat-trigger events
├── utils/
│   ├── async-channel.ts        # Bridges SDK push-based onStepFinish into async iteration (used by invokeStream)
│   └── slack-formatter.ts      # Slack message formatting utilities (mrkdwn conversion)
├── lib/
│   ├── backend-client.ts       # HTTP client for backend internal REST API
│   ├── bedrock-provider.ts     # AWS Bedrock provider factory
│   ├── llm-errors.ts           # Single owner of LLM/runtime error → user-facing text (`buildErrorStep`, budget detection)
│   ├── mcp-client.ts           # MCP tool fetching from MCP servers
│   └── prisma.ts               # Prisma client singleton (runtime database)
├── prisma/
│   └── schema.prisma           # Prisma schema for runtime PostgreSQL database
└── prompts/
    ├── context-builder.ts      # System prompt and message construction
    ├── channel-prompt.ts       # Channel-specific behavior instructions
    └── early-stopping-prompt.ts # Prompt for summarizing when step limit is reached
```

## Startup Sequence

1. Create HTTP server and initialize WebSocket gateway on `/api/ws`
2. Register channel adapters with `messageDeliveryService` (WebSocket adapter, Slack adapter)
3. Start listening on port 3003
4. Assert `AGENT_ID` is set (or auto-bootstrap one on first boot).
5. Load the one agent identified by `AGENT_ID`.
6. Initialize Slack adapter — `lib/slack-config.ts` synthesizes one connection from env (`SLACK_BOT_TOKEN`) via `auth.test`.
7. Start heartbeat timers for each agent
8. Fetch all active cron tasks directly from the database via `cronSchedulerService.listActiveCronTasks()`
9. Schedule all cron jobs

On shutdown, the Slack adapter is gracefully shut down (disconnects all Socket Mode connections).

## Environment Variables

What the operator sets on `docker run`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Agent runtime server port | `3003` |
| `AGENT_ID` | UUID of the one `AgentWorkspace` this container owns | bootstrapped on first boot |
| `DATABASE_URL` | SQLite URL for the runtime DB | `file:/data/agent.db` |
| `NEXUS_API_URL` | Nexus server URL (LLM proxy + MCP tools) | — |
| `SLACK_BOT_TOKEN` | xoxb- token; enables the Slack adapter | — (Slack disabled) |
| `SLACK_APP_TOKEN` | xapp- token for Socket Mode | — |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock Bearer API key; selected over SigV4 when set | — |
| `AWS_REGION` | AWS region for Bedrock | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS SigV4 credentials | — |
| `AWS_SECRET_ACCESS_KEY` | AWS SigV4 credentials | — |
| `BEDROCK_MODEL_ID` | AWS Bedrock model ID | `us.anthropic.claude-opus-4-8` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | Bedrock model for classification gate (heartbeat DELIVER/SUPPRESS) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (optional, enables LLM tracing) | — |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — |
| `LANGFUSE_BASE_URL` | Langfuse server URL | `http://localhost:3100` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector for product telemetry (unset/empty = disabled) | baked into published images via `vars.OTEL_EXPORTER_OTLP_ENDPOINT`; empty otherwise |
| `OTEL_EXPORTER_OTLP_API_KEY` | Collector auth, sent as `x-api-key` header | baked into published images as a file (`/app/.otel-api-key`, exported by `start.sh`) from `secrets.OTEL_EXPORTER_OTLP_API_KEY`; empty otherwise |
| `DEPLOYMENT_ENVIRONMENT` | Tags OTel records (production \| staging \| development) | `production` in published images, `development` otherwise |

## Chat Flow

There are two entry points for chat, both handled locally by the agent-runtime:

1. **WebSocket**: Client -> Backend (JWT verify + proxy) -> Agent-runtime WS gateway -> `conversationEngineService.chat()` (local, no HTTP)
2. **Slack**: Bolt Socket Mode message -> `conversationEngineService.chat()` (local, no HTTP)

In both cases, `conversationEngineService.chat()` manages the thread, **iterates `invokeStream()` directly** (no queue, no HTTP), and `messageDeliveryService.publish()`'es each text-bearing step the moment its `onStepFinish` fires. Each delivery uses a `channelContext` that scopes the publish to the originating channel only (WebSocket or Slack), so users see intermediate text from multi-step responses in real time instead of one big block at the end.

The engine keeps a **one-step buffer**: it can't know a step is the last text step until the next step (or stream end) arrives, so the last publish is the one that carries the accumulated UI `blocks` and the `shouldShowFeedback` decision. Earlier steps publish with `includeFeedback: false` and no blocks.

The management `POST /agents/chat` endpoint remains available for internal/debug use.

## Heartbeat/Cron Flow (In-Process)

Heartbeat and cron services call `invoke()` (the drain wrapper) directly in-process, no HTTP. They need the **full aggregated response** before they can act — heartbeat runs its DELIVER/SUPPRESS classification gate over the complete text, and cron classifies the run outcome — so per-step streaming would not buy anything here. Structured budget metadata flows through as `InvokeResponse.error` (populated when any step carried `error: { type: 'budget_exceeded' }`).

Results are delivered to users via local `messageDeliveryService.publishToActiveThread()`.

## Step Limit and Early Stopping

The `generateText()` call inside `invokeStream()` is capped at **100 steps** (`STEP_LIMIT` in `constants.ts`) using `stopWhen: stepCountIs(STEP_LIMIT)`. This prevents runaway agent loops.

When the step limit is reached, a follow-up `generateText()` call is made **without tools**, appending the `EARLY_STOPPING_PROMPT` (from `prompts/early-stopping-prompt.ts`). This asks the model to summarize its findings so far and produce a useful final response for the user. The summary is pushed onto the same step channel as a final `InvokeStep`, so streaming consumers (chat) see it as just another step and the `invoke()` drain wrapper aggregates it into the response like any other step.

### Shared Constants (`constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `STEP_LIMIT` | `100` | Maximum number of tool-use steps before stopping |
| `MAX_OUTPUT_TOKENS` | `16000` | Max tokens per `generateText()` call |

Opus 4.8 (like 4.7) no longer accepts `temperature`, `top_p`, or `top_k` (per Anthropic's Bedrock migration guide), so the main `invokeStream()`/`invoke()` calls omit them entirely. Haiku-backed classification gates (`heartbeat.service.ts`, `slack-adapter.service.ts`) still use `temperature: 0` — Haiku continues to accept it.

## LLM Error Handling

`lib/llm-errors.ts#buildErrorStep(error)` is the **single owner** of LLM/runtime error → user-facing text. It distinguishes Nexus RFC 7807 `budget-exceeded` 429s (returns a friendly "spending limit reached" message and tags the step with `error: { type: 'budget_exceeded', detail }`) from generic errors (returns a "I encountered an error…" step with the response body's `detail` field when present). The SDK wraps retried failures with a `lastError` field — `buildErrorStep` unwraps it before classifying.

It's used only inside `invokeStream()`'s catch paths (context-fetch failure, `generateText` rejection). Errors are pushed onto the step channel rather than thrown, so consumers don't need a separate error-handling path: chat just sees a final friendly step and delivers it; `invoke()` aggregates the text and surfaces the structured `error` field on `InvokeResponse` so heartbeat/cron can detect budget exhaustion programmatically.

## Heartbeat Design

### Prompt Contract

The heartbeat uses a minimal prompt contract.

- **System prompt**: Includes `## Heartbeats` section with configured checks from `heartbeatMd`. The prompt instructs the agent to follow its configured checks; a downstream classification gate decides whether to deliver or suppress the response.
- **User prompt**: A single sentence: `"Perform your heartbeat check now."`

### Heartbeat Result Shape

```typescript
interface HeartbeatResult {
  shouldSkip: boolean;  // true = nothing to report (gate suppressed or skipped)
  text: string;         // alert text, or skip reason
}
```

### Duplicate Suppression

Uses **full-text comparison** (not hash-based). The `HeartbeatState` tracks:

```typescript
interface HeartbeatState {
  // ... timer/status fields ...
  lastAlertText: string | null;    // full text of last delivered alert
  lastAlertAt: number | null;      // timestamp of last delivered alert
  slackTriggerPending: boolean;    // true when Slack messages queued during execution
}
```

An alert is considered a duplicate if the trimmed text exactly matches `lastAlertText` and was delivered within the last 24 hours. This replaced the earlier hash-based `recentAlerts: Map` approach for simplicity.

### Slack-Triggered Heartbeats

When a Slack message arrives in a heartbeat trigger channel, the agent-runtime's Slack adapter enqueues it in the `PendingSlackMessage` DB table and calls `triggerFromSlack(agentId)` directly (in-process). The agent-runtime then:

1. Sets `slackTriggerPending = true` on the heartbeat state
2. If not already running, calls `executeSlackTriggeredHeartbeat(agentId)`
3. Drains messages atomically from DB via `slackMessageQueueService.drain(agentId)` (direct Prisma access)
4. Processes messages in a loop: drain -> invoke LLM -> check for more messages
5. After completion, if `slackTriggerPending` was set again during execution, re-triggers

**Timer-based heartbeats also drain**: Regular timer heartbeats call `slackMessageQueueService.drain()` before invoking the LLM, so pending Slack messages are never orphaned even without an explicit Slack trigger.

**Key methods**:

- `triggerFromSlack(agentId)` — returns `'queued'` (fired immediately), `'buffered'` (will re-trigger after current run), or `'ignored'` (no heartbeat state)
- `executeSlackTriggeredHeartbeat(agentId)` — drain-and-execute loop with re-trigger on pending flag

### Classification Gate

After the main LLM call produces a heartbeat response, a second cheap LLM call acts as a DELIVER/SUPPRESS gate. This replaced the earlier fragile `HEARTBEAT_OK` token parsing.

- **Model**: Haiku via `getClassificationModel()` (from `lib/bedrock-provider.ts`), configured by `BEDROCK_CLASSIFICATION_MODEL_ID`.
- **Input**: The heartbeat response text and the last alert context (text + how long ago it was sent, formatted via `formatTimeAgo`).
- **Output**: A single word -- `DELIVER` or `SUPPRESS`. Uses `maxOutputTokens: 10` and `temperature: 0` to keep the call fast and deterministic.
- **Meta-commentary**: The gate prompt explicitly suppresses reports that are meta-commentary about the heartbeat itself (e.g. "no checks configured", "heartbeat config is empty") rather than real findings.
- **Fail-open**: If the gate call throws an error, the message is delivered (safe default).
- **Ordering**: Programmatic checks (empty response, exact-match 24h duplicate suppression) run first. The gate LLM call is only made when those checks pass.

### Default Heartbeat Template

The default `heartbeatMd` contains only headers and comments (no active checks). The agent always runs the LLM call, but when no checks are configured the heartbeat system prompt steers it to produce a plain brief "all clear" (never commentary about the config being empty), which the classification gate suppresses via `SUPPRESS`.

## Empty Message Filtering

The `context-builder.ts` skips messages with empty or whitespace-only content when building the LLM message array. This acts as a safety net for messages sourced from external providers (e.g., the `SlackThreadProvider` may return file-only messages with no text).

## Slack Adapter

The agent-runtime owns the full Slack adapter implementation. It manages Bolt apps with Socket Mode, receives messages, handles verification codes, and calls Slack APIs directly.

### Slack Architecture

- **Bolt apps**: One `App` instance per Slack workspace connection, using Socket Mode for real-time events. `clientOptions` on the `App` constructor passes a `requestInterceptor` to the underlying WebClient that strips the body `token` field so auth flows only via the `Authorization` header — necessary when the bot token is a Nexus credential sentinel that only the MITM proxy can rewrite.
- **Connection data**: source depends on mode.
  - **Multi-tenant**: SlackConnection records (tokens, workspace info) are fetched from the backend via `backendClient.getActiveSlackConnections()` at startup and `backendClient.getSlackConnection()` at runtime. Agent-runtime does NOT directly access the backend's `SlackConnection` table; the backend exclusively owns it. Connection CRUD (create, update, deactivate) is handled by the backend's org-scoped endpoints.
  - **Single-agent**: one synthetic connection is built by `lib/slack-config.ts` from the `SLACK_BOT_TOKEN` env var (validated via `auth.test` on boot). No backend, no decrypt, no encryption key. `SlackWebClient` (in `lib/slack-web-client.ts`) is the subclass that strips the body `token`.
- **Message routing**: Incoming Slack messages are processed locally via `conversationEngineService.chat()` (no HTTP to backend)
- **Response delivery**: Local `messageDeliveryService` -> local `slackAdapterService` -> local Bolt apps (no round-trip to backend)
- **Heartbeat throttle**: Handled locally with `setTimeout`
- **Verification codes**: DM and channel link verification done locally via Prisma

### Message Flow

1. Slack message arrives via Bolt Socket Mode in agent-runtime
2. Agent-runtime's `conversationEngineService.chat()` handles thread management + LLM invocation locally
3. Response delivered via local `messageDeliveryService` -> local `slackAdapterService` -> local Bolt apps

### Management API Endpoints (for Slack)

| Endpoint | Purpose |
|----------|---------|
| `POST /agents/slack/add-connection` | Initialize a Slack workspace connection (start Bolt app) |
| `DELETE /agents/slack/remove-connection` | Disconnect a Slack workspace (stop Bolt app) |
| `GET /agents/slack/channel-name` | Get the display name for a Slack channel |
| `GET /agents/:agentId/slack-link-status` | Check DM + channel mapping status for an agent |
| `GET /agents/:agentId/slack-channel-mappings` | List channel mappings for an agent |
| `GET /agents/slack/channel-mapping/:channelId` | Find a specific channel mapping |
| `DELETE /agents/slack/channel-mapping/:channelId` | Delete a channel mapping |
| `DELETE /agents/:agentId/slack/dm-mapping` | Delete DM mapping for an agent |
| `GET /agents/:agentId/slack-connection-id` | Find connectionId via SlackMapping for an agent |

### Key Files

- `services/slack-adapter.service.ts` - Full implementation with Bolt apps, Socket Mode, message handling
- `services/channel-adapter.interface.ts` - Channel adapter contract
- `services/slack-mapping.service.ts` - SlackMapping CRUD for user and channel mappings
- `utils/slack-formatter.ts` - Slack message formatting (mrkdwn conversion)
- `services/providers/slack-thread.provider.ts` - Reads thread messages directly from Slack API via local Bolt apps

### Dependencies

- `@slack/bolt` - Bolt SDK for Slack app framework and Socket Mode

## WebSocket Gateway

The agent-runtime owns the WebSocket gateway for real-time browser chat. The backend acts as a transparent WebSocket proxy, forwarding `/api/ws` upgrade requests to the agent-runtime.

### WebSocket Architecture

- **WS path**: `/api/ws` — clients connect to the backend, which verifies the JWT and proxies the upgrade to agent-runtime
- **JWT auth**: Backend verifies tokens via JWKS before proxying; agent-runtime only decodes (no verification) to extract `userId`
- **Per-user queuing**: Messages are processed one at a time per user; additional messages are queued
- **Agent status**: Gateway updates agent status (`RUNNING`/`IDLE`/`ERROR`) directly via `agentStatusService`
- **Chat flow**: Gateway calls `conversationEngineService.chat()` locally (no HTTP to backend)
- **Response delivery**: Local `messageDeliveryService.publish()` -> local `websocketAdapterService` -> local gateway's `broadcast()`

### WebSocket Key Files

- `services/websocket-gateway.service.ts` - Full implementation: WS server, JWT auth, connection management, message queuing
- `services/websocket-adapter.service.ts` - ChannelAdapter implementation, calls local gateway
- `services/agent-status.service.ts` - `updateAgentStatus()` for gateway use

## Agent Guide (agentMd)

The `agentMd` workspace file is the agent's operating manual. It appears in the system prompt as `# Agent Guide` and contains guidance on heartbeat behavior, memory usage, safety, and Slack channel etiquette. It is included in the `AgentContext` type and built into the system prompt by `context-builder.ts` (between Soul and User sections).

## Agent Skills

The runtime supports **Agent Skills** following the open standard at
[agentskills.io](https://agentskills.io) — `SKILL.md` folder bundles (YAML
frontmatter with required `name` + `description`, optional `scripts/`/
`references/`/`assets/`).

- **Where skills live.** Two sources, merged by `skillCatalogService` with
  workspace winning a name clash (project > personal, like Claude Code):
  - **Global** — `<DATA>/skills`, the persistent data dir resolved by
    `src/lib/data-dir.ts`: `/data` inside the container, `~/.prism` outside
    (local dev, SEA binary), overridable via `PRISM_DATA_DIR` (or
    `PRISM_SKILLS_DIR`). One physical copy — no duplicates.
  - **Workspace** — the repo the CLI was started in: `<workspaceRoot>/.claude/skills`
    and `<workspaceRoot>/.agents/skills` (`.claude` wins over `.agents`). The
    workspaceRoot is the thread's persisted launch cwd; autonomous heartbeat/cron
    runs have none, so they see global skills only. `getCatalog`/`find`/
    `getSkillBody` take an optional `workspaceRoot`; the `# Skills` section labels
    workspace vs installed groups. `<workspaceRoot>/.claude/skills` is also seen
    natively by the embedded `claude_code` (its cwd = workspaceRoot).
- **Shared with `claude_code`.** At startup `ensureDataDirs()` points Claude
  Code at our own config dir (`CLAUDE_CONFIG_DIR=<DATA>/.claude`) and symlinks
  `<DATA>/.claude/skills` → `<DATA>/skills`, so the embedded `claude_code` tool
  discovers the same skills — without touching the user's real `~/.claude`.
- **Progressive disclosure.** `skillCatalogService` (mtime-cached) parses only
  `name` + `description` for the `# Skills` system-prompt section; the `skill`
  tool (`src/tools/skills/index.ts`) loads a skill's full `SKILL.md` body on
  demand. The tool is omitted when no skills are installed.
- **Clients (web + CLI).** `/skills` (or `/skills list`) lists available skills
  (workspace ones labeled) via `GET /agents/skills` — scoped to the thread's
  workspace (explicit `?threadId`, else the latest thread, read-only);
  `/skills run <name>` triggers one via
  `POST /agents/skills/:name/run` (management router, shared by the web SPA and
  the CLI), which dispatches an ordinary chat turn so the reply streams over the
  WebSocket channel — automatic (model-chosen) invocation uses the same `skill`
  tool. The slash command is parsed client-side (web `SlashCommand` registry /
  TUI `commands.ts`) and calls REST; the conversation engine never parses it.
- **Installation is out of band.** Drop bundles into `<DATA>/skills` directly,
  or install with the standard CLI, e.g.
  `npx skills add <source> -g -a claude-code --copy` (writes into the
  Claude-config skills dir, i.e. the symlink → `<DATA>/skills`). The catalog
  refreshes on the skills-dir mtime, so new skills appear without a restart.
