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

Wrap commit body prose at 100 characters, but never wrap a long URL or an
attribution trailer line (e.g. the `Agent:` trailer) — leave those intact.

When a PR branch conflicts with `main`, resolve by rebasing the branch
onto `main` (`git rebase origin/main`, then force-push) — never with a
merge commit. PR branches stay merge-commit-free.

## PR descriptions

Never put a Test plan section referring to unit tests or e2e tests in a PR
description. They are in the diff and run as required checks on the PR
page, so listing them is self-evident noise. The same goes for
"`<workflow>.yml` green".

Describe only verification a reader cannot get from the diff or the PR's
checks: a local smoke run, a manual UI walk, a specific command and what
it showed.

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
- **Not excessive** — instrument durable lifecycle outcomes, not every cosmetic
  cue or per-step detail. A high-volume decoration (e.g. a per-message typing
  indicator) is noise; the turn-level event (`chat message handled`) already
  covers that activity.
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

The docs in `docs/` are **user-facing**: describe observable behavior,
configuration and troubleshooting, never implementation details. Keep internal
module, function and enum names, algorithm descriptions, and benchmark or
corpus numbers out of them. Name a third-party component only when the user
installs, configures or sees it. Implementation rationale belongs in a code
comment, the PR description, or an ADR. A shorter doc page is the right answer
when a change has nothing a user can observe.

## Code conventions

- **One component per file.** Each React (`web/`) and Ink (`cli/`) component
  lives in its own file named for the component (kebab-case, e.g.
  `model-field.tsx`), not several components sharing a module. A component's
  small private helpers may stay in its file; shared ones move to a module.
- **No Jira issue keys in code.** Never reference Jira tickets (e.g.
  `AGENT-96`) in source files, comments, or tests. Ticket references belong
  in commit messages and PR descriptions, where they stay linked to the
  change; a comment must explain the behavior on its own.

## Deployment shape

One `AGENT_ID` per container, embedded SQLite + sqlite-vec at
`file:/data/agent.db`. The image is `ghcr.io/lensapp/prism-agent`, published
under five tag families: `latest` and `vYYYY.M.DDHHMMSS` (production),
`canary` (every merge to `main`), a commit-SHA tag from both release workflows,
and `pr-<n>` + `pr-<n>-<branch-slug>` from `docker-build.yml` on every pull
request that rebuilds the image. The PR pair moves with each such push and
`pr-image-cleanup.yml` deletes it when the PR closes. A fork's PR builds the
image and pushes nothing — its token is read-only. Slack creds come from env
(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`), validated via `auth.test` on boot; may
be Nexus credential sentinels (`__nexus_cred:<uuid>__`) rewritten by the MITM
proxy.

One LLM provider per container, selected by `LLM_PROVIDER` (`bedrock`
default, `azure`, `bedrock-mantle`, or `openai`). The first three serve
**Claude**; `openai` serves OpenAI models.
**Bedrock** via Bearer API key (`AWS_BEARER_TOKEN_BEDROCK`) — the SDK
auto-selects Bearer over SigV4 when set. **Azure = Claude via Microsoft
Foundry**: chat/classification
speak the Anthropic Messages API at
`https://{AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1/messages`
with `AZURE_API_KEY` sent as `x-api-key` (may be a `__nexus_cred:<uuid>__`
sentinel); model IDs are Foundry deployment names (defaults
`claude-opus-5` / `claude-haiku-4-5`). Azure embeddings come from an
Azure OpenAI `text-embedding-3` deployment on the same resource
(default `text-embedding-3-small`; fails open if the deployment is
absent, or set `AZURE_EMBEDDING_MODEL_ID=''` to skip).
**Bedrock Mantle** is AWS's second inference endpoint, a *separate provider*
rather than a Bedrock variant because it serves neither InvokeModel nor
Converse: chat/classification speak the Anthropic Messages API at
`https://bedrock-mantle.{AWS_REGION}.api.aws/anthropic/v1/messages`, reusing
`AWS_BEARER_TOKEN_BEDROCK` as `x-api-key` (**required** direct — there is no
SigV4 path on that surface). Its model IDs are **bare** Bedrock IDs (defaults
`anthropic.claude-opus-5` / `anthropic.claude-haiku-4-5`) since
mantle has no cross-region inference profiles; the provider strips a `us.`/
`eu.`/`global.` prefix off per-agent overrides rather than 400ing. Mantle
serves no embedding models, so memory embeddings stay on Titan over
bedrock-runtime (`BEDROCK_MANTLE_EMBEDDING_MODEL_ID=''` to skip).
**OpenAI** is the one vendor not serving Claude: chat/classification speak the
OpenAI Responses API (defaults `gpt-5.6-sol` / `gpt-5.6-luna`) and embeddings
`text-embedding-3-small` truncated to 1024 dims (`OPENAI_EMBEDDING_MODEL_ID=''`
to skip) — one surface, one key (`OPENAI_API_KEY`, shared with voice meetings;
may be a `__nexus_cred:<uuid>__` sentinel since it only rides a header). The
provider declares `classificationProviderOptions: { openai: { reasoningEffort:
'none' } }` plus empty gate sampling params — the gates omit `temperature` on
OpenAI rather than track which model/SDK combination accepts it — so their
tiny token budgets stay valid on a GPT-5.x classification model, and the empty
cache-point fragment (OpenAI prompt caching is automatic — no breakpoints). Any provider
can run direct or through the Nexus LLM gateway — routing is automatic when
`NEXUS_API_URL` is set (`…/llm/bedrock/{region}` for Bedrock; Azure chat
rides `…/llm/azure/anthropic/v1` and Azure embeddings
`…/llm/azure/openai/v1`; mantle chat rides
`…/llm/bedrock-mantle/anthropic/{region}/v1` while its embeddings stay on the
bedrock mount; openai chat, classification and embeddings all ride
`…/llm/openai/v1`, a Nexus backend since nexus-monorepo#483; Nexus holds the
platform credentials, so no local LLM key is needed on that path). The one
OpenAI call that never rides Nexus is the voice-meeting Realtime WebSocket —
the openai mount routes POST only.

## SEA binaries — Node 22 pin

The `prism` / `prism-server` SEA build (workflows: `create-binary.yml`,
called from `release-production.yml`) is pinned to **Node 22**. Don't bump
it to 23+ without refactoring the bundle loader.

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

Every Prisma command needs `--schema=prisma/sqlite/schema.prisma` — the
schema is not in a default location, so a bare `prisma …` fails with
"Could not find Prisma Schema".

**`prisma migrate dev` does not work against a dev database that has
already run.** It describes the whole database, and once
`sqliteBootstrap` has created the `sqlite-vec` virtual tables
(`memory_entry_vec*`) that fails with "Error describing the database" —
the schema engine has no `vec0` module. Use `migrate deploy` (what
`dev:single` runs) to apply migrations. To author a new one, point
`DATABASE_URL` at a throwaway file so `migrate dev` sees a fresh
database, then commit the generated migration.

A worktree's `node_modules` is a symlink to the repo's, so every worktree
shares **one** generated Prisma client at `node_modules/.prisma/client`
(`@prisma/client` is a shim that re-exports it). The client is generated
code with the column list baked in, so `prisma generate` in a worktree
whose schema has an extra column — run directly, or implicitly by
`npm run dev` (`predev`) or `prisma migrate dev` — makes every *other*
worktree's runtime query a column its database lacks: "The column X does
not exist in the current database".

Regenerating with this worktree's schema fixes it, and `npm run dev`
already does that via `predev` — so the failure only bites a runtime that
was already running when another worktree generated. There is no cheap
isolation: a custom `generator client { output = … }` stops Prisma wiring
`@prisma/client`, so every import would have to change. Just don't run
Prisma commands in two worktrees while a runtime is up.

Browser → `http://localhost:5173`. UI edits hot-reload in <1s, runtime
TypeScript edits restart the server in ~1s. The Vite proxy forwards `/agents`
and `/api/ws` to `:3003` so the SPA code doesn't know it's not hitting the
same origin.

The runtime auto-loads `.env` via dotenv. Slack and Bedrock are optional —
`lib/slack-config.ts` and `lib/llm-providers/bedrock/bedrock-provider.ts`
fail-open when their tokens are unset. The SPA shell, navigation, profile,
`/agents/me`, `/agents/:id/details`, `/agents/:id/cron-tasks` work with zero
extra env. Add `AWS_BEARER_TOKEN_BEDROCK` (or AWS SigV4) in `.env` for chat;
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

### Self-sufficiency — owns its data, no backend

The runtime is self-contained: there is no backend, no `/internal/api`
calls, and no internal API secret. The container owns exactly one
`AgentWorkspace` (identified by the `AGENT_ID` env), reads its Slack
connection from env (`lib/slack-config.ts`), and persists everything
locally.

1. **Owns its data** — agent CRUD/ownership/subagents, conversation
   threads + messages, active-thread resolution, agent field updates
   (heartbeat timestamp/status), cron task state, Slack mappings, and the
   pending Slack-message queue all live in the embedded SQLite DB
   (`file:/data/agent.db`) accessed via Prisma. Vector search over
   `memory_entries.embedding` goes through a sibling `better-sqlite3`
   handle that loads the `sqlite-vec` extension (`lib/sqlite-bootstrap.ts`).

2. **Exposes a Management API** (`/agents/*`) consumed by its local
   clients — the bundled web SPA and `prism-cli` (not a backend): chat and
   thread/message CRUD, heartbeat start/stop/trigger + status, cron
   schedule/unschedule, Slack link/verification codes + mapping queries and
   mutations, and skills list/run. The Slack-specific endpoints are
   detailed in the "Management API Endpoints (for Slack)" table below.

### Tools

1. **Built-ins** — direct AI SDK tools in `src/tools/` (memory, agent config, cron,
   goals, shell/Claude Code, share-file, skills, meetings), assembled by
   `lib/tool-collection.ts#collectTools` and filtered per invocation mode. There is
   **no internal MCP server** — these are in-process closures, not an HTTP surface.
2. **Nexus MCP** — kubectl, GitHub, AWS tools (external, via `NEXUS_MCP_URL`).
3. **Plugin MCP** — whatever an installed Agent Plugin declares in its `mcp.json`;
   stdio, Streamable HTTP or legacy SSE (`services/plugin-mcp.service.ts`).

## Key Services

| Service | File | Purpose |
|---------|------|---------|
| **invokeStream** | `invoke.ts` | Streaming primitive: builds context, collects tools, calls `generateText()` with step limit and early stopping, yields each `InvokeStep` as `onStepFinish` fires. Errors are yielded as friendly steps (via `buildErrorStep`) rather than thrown. Bridges the SDK's push-based callback into async iteration via `utils/async-channel.ts`. |
| **invoke** | `invoke.ts` | Thin aggregating wrapper around `invokeStream()`: drains the step stream into a single `InvokeResponse`. Used by callers that need the full result before acting (heartbeat, cron, subagent/task tool). |
| **ConversationEngineService** | `services/conversation-engine.service.ts` | Chat flow orchestration: thread management, iterates `invokeStream()` directly and publishes each text-bearing step the moment it arrives, delivers via local `messageDeliveryService` |
| **MessageDeliveryService** | `services/message-delivery.service.ts` | Unified message publish: stores via `conversationService`, delivers via channel adapters (channel-scoped for user messages, broadcast for autonomous) |
| **ThreadTurnService** | `services/thread-turn.service.ts` | The one per-thread primitive: every model invocation on a thread serializes on its mutex (FIFO — chat turns and goal turns alike), and a chat turn *claims* the thread, so a message arriving from the claim until the exchange ends is handed to that turn instead of starting a second one. Channel-agnostic — transports go through the engine, never here directly |
| **ContextService** | `services/context.service.ts` | Builds agent context from local database: agent data via `agentWorkspaceService.getAgentById()` and conversation history via Prisma |
| **ConversationService** | `services/conversation.service.ts` | Thread and message CRUD via Prisma, pluggable thread providers (database + Slack) |
| **AgentWorkspaceService** | `services/agent-workspace.service.ts` | Agent CRUD, ownership validation, nexus token management, subagent relationships |
| **AgentStatusService** | `services/agent-status.service.ts` | Direct Prisma writes for agent fields (heartbeat timestamp, heartbeat status) |
| **HeartbeatService** | `services/heartbeat.service.ts` | Always-on monitoring loop with in-process timers, full-text duplicate suppression, Slack-triggered heartbeats |
| **CronSchedulerService** | `services/cron-scheduler.service.ts` | Scheduled task execution using node-cron and setTimeout; manages cron task state directly via Prisma (list, update run timestamps, delete); skips a tick that would overlap a still-running execution of the same task; runs each result through the instruction-aware DELIVER/SUPPRESS gate before delivering (empty results suppressed, error results bypass the gate and always deliver, in-memory per-task last-delivered baseline fed to the gate as context — cleared when a suppressed run observes a different situation so a recurrence re-alerts — fail-open) |
| **SlackAdapterService** | `services/slack-adapter.service.ts` | Full Slack implementation: Bolt apps, Socket Mode, message handling, verification codes |
| **SlackMappingService** | `services/slack-mapping.service.ts` | SlackMapping CRUD for user and channel mappings via Prisma |
| **SlackMessageQueueService** | `services/slack-message-queue.service.ts` | Direct Prisma drain of pending Slack messages for heartbeat triggers |
| **SlackHeartbeatTriggerService** | `services/slack-heartbeat-trigger.service.ts` | CRUD for per-agent Slack heartbeat trigger config, atomic claim logic |
| **SessionManagerService** | `services/session-manager.service.ts` | Daily session resets, idle timeout management |
| **MemoryManagerService** | `services/memory-manager.service.ts` | Two-layer memory: daily append-only logs + curated long-term key-value store |
| **MeetingBotService** | `services/meeting/meeting-bot.service.ts` | Live voice meetings: owns one call at a time (Xvfb + PulseAudio virtual devices + Chromium spawned as an ordinary process and driven over CDP, plus an OpenAI Realtime session). Joins **signed into a Google account** — Meet auto-denies automated anonymous guests, so this is required rather than preferred; the browser profile persists under `<DATA>/meeting-browser-profile`. The Realtime model *is* the agent in the room — it carries the agent's system prompt (`buildSystemPromptParts(ctx, 'meeting')` + `prompts/meeting-prompt.ts`) and its real tools, bridged in as Realtime function tools and executed in-process (`tool-bridge.ts`). `meeting` mode is chat's tool set **minus `share_file`** — a meeting runs neither the invoke loop nor the conversation engine that deliver what it stores, so it could only file something away that reached nobody. Speech is the only channel out of a call (there is no message-send tool), which `prompts/meeting-prompt.ts` now states outright so the model stops offering to "drop it in the chat". That prompt's confirmation rule is the *only* guard on everything else, self-configuration included: it used to refuse spoken attempts to rename the agent or rewrite its Soul/profile/memory, and at the operator's request it no longer does — so a sentence agreed in an unauthenticated call can change the agent for every future turn on every channel. Everything Google-specific sits behind `MeetingProvider` in `providers/google-meet/` — the join flow *and* the account sign-in, which the provider owns rather than the browser stack. It answers `configurationError()` (why it cannot run at all, checked before a call's worth of infrastructure is built) and `signIn(page, {force})`, which never throws because a failed login is not a reason to refuse a join the profile's cookies might carry. `browser-stack.ts` is a real browser on a virtual display with a persistent profile, and nothing else. Adding Teams means adding one folder. Barge-in is local, not server-side, so a backchannel doesn't cut the bot off (`barge-in.ts` + `audio-playback.ts`). **Responses are local too**: `create_response` is off for every call, and `response-policy.ts` decides which utterances become speech — everything in a one-to-one (fired at the turn boundary, so no slower than the server doing it), and otherwise the single question *was the agent called by name* — not whether the sentence sounds like a request, which a mixed mono channel cannot answer. That question is asked twice per utterance (once from the streaming partial transcript, once on completion) and answered by two checks in series: `vocative.ts` first, locally and in 0ms, then a one-word Haiku verdict from `addressed-classifier.ts`. The local read is now **off by default** and enabled by `MEETING_LOCAL_ADDRESSED_READ=true`: its only way to fail is answering a room that addressed nobody, and a fast classification model answers the gate in about 750ms measured over live calls, so the saving stopped paying for that risk. Where it runs it is **YES-only** — it can make the agent quicker, never quieter — matches the name **exactly** (a mangled name is the model's job, and prefix/phonetic tolerance gained 0 of 23 addresses once keyword seeding is on, while matching a colleague's name onto the agent's), and decides on *grammar*, not on the name appearing: a vocative sits at a clause edge with no grammatical role and has positive evidence of address, while a finite verb after the name makes it a subject and a preposition before it an object. Four further shapes were each found being answered, and each closed by a grammatical narrowing rather than a word list: reported speech ("Iris said you should check the deploy" — the second-person exemption now needs an *inverted auxiliary*, `Iris are you…`, not a `you` anywhere in the sentence), an appositive ("Iris, our agent, flagged it first" — a finite verb resuming after the aside's closing comma), an enumeration ("Iris, Slack and Bedrock are all down" — a coordinator before any verb), and a question about the agent ("Who is Iris?" — an unfenced trailing name is a predicate, and the question mark is no evidence). POS tags and lemmas come from wink-nlp + `wink-eng-lite-web-model` (lazy-loaded: 70MB RSS, and most containers never hold a call), because the distinction between "Iris said no" and "Iris go ahead" is *inflection* rather than anything a word list can express; two earlier presence-based versions leaked 11/12 and 6/6 mentions. English-only and explicit about it — non-Latin script or a tagger failure defers to the language-agnostic model gate, exercised live by two Greek mis-transcriptions. Measured 24/24 addresses, 0/41 mentions, and 23/23 on real transcriber output with keyword seeding. The model rather than a regex because transcription mangles names ("Prism" → "Pritham"), the name is arbitrary user-set text, and a name can be mentioned without being addressed. Fails **closed**, unlike the heartbeat/cron gates: it sits in front of most utterances in a call, so failing open would answer a whole room. Input transcription is on for every call and pinned to English. The mode follows the participant count the auto-leave watchdog already polls; an unreadable count never changes it. Answers are spoken at the *turn boundary*, never the moment a verdict lands: judging early hides the gate's ~1.3s behind the rest of the sentence, but acting on it early made the agent answer a request it had only half heard. In `open` mode the early look is skipped entirely — the utterance is answered at the boundary regardless, so judging it was a model call per sentence for nothing. Speaker attribution comes from Meet's own **participants panel** (`providers/google-meet/participants.ts`): each row has the person's name in its `aria-label`, a per-device `data-participant-id` stable for the call, and a voice meter (`[jscontroller="ES310d"]`) whose class changes while they talk. The panel is per-viewer, so nobody in the room sees it opened. Callers compare the **id**, never the name — two people can share a display name and a name can change mid-call. The agent's own row is marked `(You)` and reported as `isSelf` rather than filtered, since "that was me" and "cannot tell" are different answers. This replaced a caption-pane scrape that failed three ways in live calls: merged audio (two people in one room) captioned as `"groupsMario Sarcher & 1 others"`, matching nobody on the roster, so attribution stopped silently for both; caption text lags speech by 1-2s; and a caption line is structurally identical to a sentence fragment, which needed a roster cross-check to undo. The panel has none of that and *covers* merged audio — the members' meters go still and a cohort row's moves instead, so the answer degrades to one correct group identity, flagged `isGroup` so nothing reads "Merged audio" out as a person's name. Opened by the **service** ahead of the greeting (Meet starts every call with the panel shut, and with it shut the list is not in the page at all) and retried on the participant poll while nothing has ever been attributed, the same shape as `ensureUnmuted` — one caller, so the interface contract holds for the next platform. Speech is told from a mute toggle by *churn*: one class change is a state change, so `judgeSpeaker` needs two transitions inside 800ms, and a `MutationObserver` installed in the page records them because a 1s poll lands in the gaps between words. Only mutations with the meter on the path up to the row count — `childList` is deliberately unobserved, since a row re-rendering because somebody joined would otherwise read as that person speaking. Rows are judged against their own history and never each other's: the silent rows' class strings differ (host, mute, self state), so only the slot that moves is amplitude. Two rows churning within 400ms answers null — one mixed channel cannot attribute an overlapping utterance, and a coin flip would arm an exchange for the wrong person. Read on its **own 1s timer**, not the 10s participant poll, since a whole exchange fits inside one slow tick. `VoiceConversation` holds the reading, ages it out after 6s (still meters are a pause, not a stop) and reports `attribution_rate` on `meeting ended`. That rate counts utterances that got a *speaker*, not readings that came back: the old definition scored the agent's own voice as a success, so it could read 100% while nothing could be attributed to a person at all. The same panel is the roster and the count — a row's `aria-label` needs no un-gluing, where tile text arrives doubled with control labels attached and un-gluing it had already turned "Miska" into "M" — while the count keeps largest-of-three (panel rows, the People control's own `"People2"` badge text, and distinct participant ids page-wide) because the panel needs opening, the badge is English, and the ids under-report when Meet virtualizes tiles. The model is no longer told the speaker is unknowable: it is told who it is answering, and `meeting_speaker` reports who spoke last, who is in the room, and whether attribution works at all — from cached state only, since a CDP round trip mid-turn is silence in the room, and exempted from the prompt's speak-before-a-tool rule for the same reason. That attribution is what makes `follow-up-window.ts` safe: after the agent answers somebody, **that person** may follow up for `MEETING_FOLLOW_UP_WINDOW_MS` (default 8s, `0` disables) without saying the name again. Three conditions, all required — inside the window (measured from the agent's *turn ending* — playback drain or barge-in, since what one follows up on is the answer — to the moment the follow-up **starts**, keyed to the item's first partial: judging the clock on the finished transcript instead declined a speaker who began 2.3s after the answer and spent seven seconds asking, i.e. penalised a follow-up for its length), not addressed to anybody else, and question- or request-shaped — where being handed the floor back ("go ahead", "carry on", "you were saying") counts as a request, since a live call cut the agent off and then invited it to continue and got silence. `HORTATIVE` is tested first, so "let's carry on" is still the group moving along. Armed on **any** addressed verdict rather than on the name appearing literally ("…the reason why I asked you to join, Max" was judged addressed, answered, and armed nothing). **Only a finished transcript is *accepted or closed on*, in either direction** — a rule about what was said, which is why the clock above is keyed separately to when the speaking began. Closing on a partial shut the window mid-request (an unfinished sentence reads as a statement); accepting on one is the same mistake — "And what do you think" passes every test and belongs to "…about the rollout, Pamela?", so the answer locks in before the words saying who it was for arrive. The window is also suspended for the length of each answer (`onAgentTurnStarted`, and `arm()` zeroes the clock), or a backchannel over a ten-second reply is judged against the previous turn's timestamp and one-strike closes an exchange that has not started. **Anybody in the room may continue it, not only the person answered** — asked for out loud on a live call ("it would feel more natural if anybody can keep going with the agent, and only after some other name is mentioned would it be disabled"), so eligibility is about what is said rather than who says it. Two things follow. The window no longer depends on speaker attribution at all, so it survives a call whose panel cannot be read; attribution's remaining job is telling the agent who it is talking to via `meeting_speaker`. And a bystander's backchannel now reaches the shape test, which would close the exchange — the exact failure `MEETING_FOLLOW_UP_OTHER_SPEAKER_CLOSES` guarded (1 accepted follow-up in six minutes vs 4 in the minute after switching it off) — so that knob's graduated rule became unconditional instead of being deleted with it: under 6 words a statement is declined without closing, at or above it the exchange ends. `HORTATIVE` is therefore tested per *clause*, since "right, let us move on" is five words and moving the group along has to close whatever its length. The drift guards reuse PR1's tagger via `addressedToSomeoneElse()`, which turned a 33-word hand-written filler list into 2 entries — the tags already answer for the other 27, and group vocatives (`the team`, `you guys`, `folks`) stay a regex because they are a closed class the tagger reads as proper nouns. It reads four vocative positions per **sentence** (leading+comma, leading comma-less before an inverted question, trailing+comma, fenced mid-sentence with second person behind) and consults the scraped roster, since a lower-cased name tags as a common noun; without all of that it saw only the leading-comma form and answered "What do you think, Pamela?", "Pamela can you get the numbers?" and "Thanks for the update. Pamela, could we…". Positions 1-3 additionally require second person or a question mark, or "Monday, we should ship" reads as an address. The roster is the *limit* as well as the widening: with one in hand, a proper noun matching nobody in the room is not somebody being spoken to, and the match allows a small edit budget (none under four letters, one to five, two beyond) because transcription mangles names — "Yari" for "Jari" was answered as a follow-up when the question was plainly for him. Hand-rolled Levenshtein, not a phonetic algorithm: Soundex and Metaphone both key on the first letter, so those two differ under either. A question mark is also required at every fenced vocative position, since a stray `you` elsewhere in the sentence was what read "Gotcha, thank you" as an address. That closed a class rather than an instance — a live call declined "Gotcha, thank you… Can you check that?" because an unknown capitalised word tags PROPN and "thank you" behind it supplied the second person, and `NOT_A_NAME` could have absorbed `gotcha` but not `righto`, `aha` or the next one. Only sound because the roster now comes off the participants panel, so it is complete while the panel is open; it is still up to a poll stale, so a brand-new joiner addressed by name is not on it yet, and a name mangled past recognition will not match — which is what seeding the roster to the transcriber is for. Without a roster it falls back to the tag alone, so a capitalised plural common noun ("Dogs, do you…") still reads as a name there, which is the safe direction. The window can only ever *add* an answer, so its failure mode is latency. Known limit inherited from the attribution source: the speaker snapshot lags the words it is compared against (poll ≤1s, gate verdict ~1.3s), so a speaker change inside that lag can arm for the wrong person — the 6s freshness bound handles staleness, not skew. `follow-up-shadow.ts` measures its precision after the fact with a **different** question (CONTINUE/MOVED_ON) — shadowing the addressed gate would be meaningless, since a follow-up has no name and that gate would say no to all of them. The agent's name and the room's roster (scraped alongside the participant count) are seeded to the transcriber as `keywords` and the roster is also sent to the model as context, since a mixed mono channel gives it no other way to know who is present. `[Meeting:Latency]` logs the silence the room actually experienced, split into the part the gate cost and the part the Realtime model did — ~0ms and ~1.3s whenever the local read fires, at either edge of the sentence, and ~1.3s of gate on top when only the model can see the name. `[Meeting:Gate]` logs `path=local` or `path=model local="<reason>"`; `VocativeReason` is a bounded enum, so that token is safe to write under `MEETING_TRANSCRIPT_LOGGING=off`, and `meeting ended` reports `gate_local_yes` / `gate_model_calls` / `gate_local_share`. Losing either half of the audio path ends the call, rather than leaving a mute, deaf tile in the room until the empty-room poll or the duration cap notices: `VoiceConversation`'s `onSessionLost` fires for any Realtime close the runtime didn't initiate, and `AudioStack`'s `onLost` for a `parec`/`pacat` death (deaf and mute respectively); both post a note and tear down. The startup path publishes nothing onto the service's fields until it has re-checked the epoch — a `leave()` mid-startup returns the service to `idle` and so frees it for a second `join()`, and the abandoned startup has to release its own browser and session rather than overwrite the live call's or drag it down with its own late failure |
| **PluginCatalogService** | `services/plugin-catalog.service.ts` | Discovers Agent Plugins under `<DATA>/plugins`, validates each `plugin.json`, records per-plugin diagnostics |
| **PluginMcpService** | `services/plugin-mcp.service.ts` | Connects each plugin's MCP servers (lazily, once per server), qualifies and orders their tools, closes them at shutdown |
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
│   ├── thread-turn.service.ts  # Per-thread mutex + mid-turn inbox (turn steering, coalesced follow-ups)
│   ├── agent-workspace.service.ts # Agent CRUD, ownership validation, nexus tokens, subagents
│   ├── agent-status.service.ts  # Direct Prisma writes for agent fields (heartbeat timestamp/status)
│   ├── websocket-gateway.service.ts # WebSocket server: JWT decode (backend verifies), connection mgmt, message queuing
│   ├── websocket-adapter.service.ts # ChannelAdapter for WebSocket, calls local gateway
│   ├── channel-adapter.interface.ts # Channel adapter contract (ChannelAdapter interface)
│   ├── context.service.ts      # Builds agent context (agent data from backend + conversation from DB)
│   ├── conversation.service.ts # Thread/message CRUD via Prisma, pluggable thread providers
│   ├── attachment.service.ts   # All MessageAttachment DB access + media-type detection; content as files (lib/media-store.ts), metadata stubs to the model
│   ├── heartbeat.service.ts    # Heartbeat timer management, execution, and Slack-triggered heartbeats
│   ├── cron-scheduler.service.ts # Cron job scheduling and execution
│   ├── slack-adapter.service.ts   # Full Slack implementation: Bolt apps, Socket Mode, message handling
│   ├── slack-mapping.service.ts   # SlackMapping CRUD for user & channel mappings via Prisma
│   ├── slack-message-queue.service.ts # Direct Prisma drain of pending Slack messages
│   ├── slack-heartbeat-trigger.service.ts # CRUD for per-agent Slack heartbeat trigger config, atomic claim logic
│   ├── session-manager.service.ts # Daily session resets, idle timeout management
│   ├── memory-manager.service.ts  # Two-layer memory system (daily logs + curated key-value store)
│   ├── meeting/                # Live voice meetings (OpenAI Realtime API)
│   │   ├── meeting-bot.service.ts    # Lifecycle owner: one call at a time, teardown, telemetry
│   │   ├── meeting-provider.interface.ts # The only platform-specific seam (Teams/Zoom later)
│   │   ├── providers/google-meet/    # Everything Google-specific lives here
│   │   │   ├── index.ts        # The provider: join, admission, participants, leave
│   │   │   ├── participants.ts # Who is here and who is talking, off the panel (per-viewer)
│   │   │   ├── with-timeout.ts # Deadline for a read from a live page, shared by the probes
│   │   │   └── sign-in.ts      # Google account auth (never throws; `force` skips the probe)
│   │   ├── audio-stack.ts      # Per-meeting Xvfb + PulseAudio null-sinks + parec/pacat
│   │   ├── browser-stack.ts    # A browser on a virtual display. No auth — that's the provider's
│   │   ├── voice-conversation.ts # Wires session + playback + barge-in + policy + tools
│   │   ├── realtime-session.ts # Realtime WebSocket protocol (semantic VAD, truncation)
│   │   ├── tool-bridge.ts      # collectTools('meeting') → Realtime function tools
│   │   ├── audio-playback.ts   # Paced playback + accurate played-ms for truncation
│   │   ├── barge-in.ts         # Yield the floor to humans, tolerate backchannels
│   │   ├── response-policy.ts  # Whether to answer at all: open vs addressed, follow-up window
│   │   ├── follow-up-window.ts # Staying in an exchange without being named again
│   │   ├── follow-up-shadow.ts # Was that follow-up really one? Judged after the fact
│   │   ├── vocative.ts         # "Did someone call my name?" — local, YES-only, 0ms
│   │   ├── addressed-classifier.ts # The same question, asked of Haiku. Fails closed
│   │   ├── transcript-log.ts   # Whether a log line may carry an utterance at all (`MEETING_TRANSCRIPT_LOGGING`)
│   │   ├── resampler.ts        # 48k⇄24k pcm16 with anti-alias FIR
│   │   └── openai-endpoint.ts  # Direct wss://api.openai.com — no Nexus mount exists
│   ├── skill-catalog.service.ts   # Agent Skills discovery (workspace, global, plugin roots)
│   ├── plugin-catalog.service.ts  # Agent Plugins discovery + plugin.json validation
│   ├── plugin-mcp-config.ts       # mcp.json parsing/validation (pure; no SDK, no I/O)
│   ├── plugin-mcp.service.ts      # Plugin MCP connections, tool naming, shutdown
│   ├── thread-provider.interface.ts # ThreadMessageProvider abstraction
│   └── providers/
│       ├── database-thread.provider.ts # Default: reads messages from PostgreSQL
│       └── slack-thread.provider.ts    # Slack: reads messages via local Bolt apps (direct Slack API)
├── tools/                      # Built-in AI SDK tools (no MCP round trip)
│   ├── memory.ts               # Memory tools (search, write, delete)
│   ├── agent-config.ts         # Agent config tools (soul, user, memory, heartbeat, vision, settings)
│   ├── cron.ts                 # Cron task tools (schedule, list, delete)
│   ├── goals.ts                # Goal tools (create, get)
│   ├── attachments.ts          # hydrate_attachment (stored bytes → workspace file) + view_attachment (image/PDF into the turn) + `reapScratchDirs`
│   ├── share-file.ts           # Deliver a workspace file to the user as an attachment
│   ├── meeting.ts              # Voice meetings (join_meeting, leave_meeting, meeting_status)
│   ├── shell/                  # shell_exec/read/write/edit, spawn+stdio, claude_code
│   └── skills/                 # The `skill` tool (loads a SKILL.md body on demand)
├── routes/
│   └── management.ts           # Management API for backend to push heartbeat/cron/slack-heartbeat-trigger events
├── utils/
│   ├── async-channel.ts        # Bridges SDK push-based onStepFinish into async iteration (used by invokeStream)
│   └── slack-formatter.ts      # Slack message formatting utilities (mrkdwn conversion)
├── lib/
│   ├── attachment-boot.ts      # Boot-time attachment storage reconciliation, in order: missing media files → content expiry → legacy BLOB backfill
│   ├── attachment-janitor.ts   # Hourly attachment sweep: orphaned uploads, stale hydrate scratch dirs, over-TTL content, stray media files
│   ├── backend-client.ts       # HTTP client for backend internal REST API
│   ├── llm-providers/          # One folder per LLM vendor, plus the shared contract and the selector
│   │   ├── llm-provider.ts     # Shared `LlmProvider` type: the callable `(modelId) => LanguageModel` + `.embedding(modelId)` contract every vendor factory returns, plus each vendor's `cachePoint` fragment (Anthropic breakpoint or the empty `NO_CACHE_POINT`) and the optional `structuredOutputOptions` / `classificationProviderOptions` it declares
│   │   ├── create-provider.ts  # Unified LLM provider factory: picks vendor (bedrock/azure/bedrock-mantle/openai), passes each its optional Nexus baseURL; `isProviderConfigured()`
│   │   ├── bedrock-shared.ts   # bedrock-runtime plumbing both AWS vendors need: AWS credential resolution, the generic Converse/embeddings provider (mantle's Titan leg), `isAnthropicModelId()`
│   │   ├── bedrock/
│   │   │   └── bedrock-provider.ts # AWS Bedrock provider factory: `createBedrockProvider(baseURL?)` (direct, or Nexus when baseURL set)
│   │   ├── azure/
│   │   │   └── azure-provider.ts   # Azure provider factory (Claude via MS Foundry, Anthropic Messages API; embeddings via Azure OpenAI): `createAzureProvider(baseURL?)`
│   │   ├── bedrock-mantle/
│   │   │   └── bedrock-mantle-provider.ts # Bedrock Mantle factory (Anthropic Messages surface only; bare model IDs, embeddings borrowed from bedrock-runtime): `createBedrockMantleProvider(baseURL?)`
│   │   └── openai/
│   │       └── openai-provider.ts # OpenAI factory (Responses API; one surface for chat/classification/embeddings; pins gate calls to reasoningEffort 'none'): `createOpenAiProvider(baseURL?)`
│   ├── classification.ts       # Classification-gate request factories (`getGateRequest()` for the generateText gates, `getClassificationRequest()` for generateObject) — model + the active vendor's merged `providerOptions`
│   ├── classification-gate.ts  # Shared one-word-verdict gate call (`runClassificationGate`) + `isRecentDuplicate`, used by the heartbeat and cron DELIVER/SUPPRESS gates
│   ├── llm-errors.ts           # Single owner of LLM/runtime error → user-facing text (`buildErrorStep`, budget detection)
│   ├── log-redaction.ts        # The global pino `err` serializer: an allow-list, so no SDK request/response body is ever logged
│   ├── mcp-client.ts           # MCP tool fetching from MCP servers
│   ├── media-store.ts          # Attachment bytes as files under `<data dir>/media`: write/read/remove, filename sanitizing, stray-file reaper
│   └── prisma.ts               # Prisma client singleton (runtime database)
├── prisma/
│   └── schema.prisma           # Prisma schema for runtime PostgreSQL database
└── prompts/
    ├── context-builder.ts      # System prompt and message construction
    ├── channel-prompt.ts       # Channel-specific behavior instructions
    ├── cron-prompt.ts          # Scheduled-task DELIVER/SUPPRESS gate prompt (instruction-aware) + gate user-message builder
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
| `LLM_PROVIDER` | LLM vendor: `bedrock`, `azure`, `bedrock-mantle`, or `openai` (one per container) | `bedrock` |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key; on Bedrock selected over SigV4 when set, on mantle sent as `x-api-key` and **required** direct | — |
| `AWS_REGION` | AWS region for Bedrock and for the mantle host | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS SigV4 credentials | — |
| `AWS_SECRET_ACCESS_KEY` | AWS SigV4 credentials | — |
| `BEDROCK_MODEL_ID` | AWS Bedrock model ID | `us.anthropic.claude-opus-5` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | Bedrock model for every classification gate: the meeting addressed gate, and the heartbeat and scheduled-task DELIVER/SUPPRESS gates. Not the chat family, because a gate returns one word and pays almost all of its cost in time to first token — measured over live meeting calls, a median 748ms against 1232ms for Claude Haiku 4.5, at the same accuracy on 220 sentences from real transcripts | `us.amazon.nova-2-lite-v1:0` |
| `AZURE_RESOURCE_NAME` / `AZURE_API_KEY` | Foundry resource + key (Claude via Microsoft Foundry; used when `LLM_PROVIDER=azure`) | — |
| `AZURE_MODEL_ID` / `AZURE_CLASSIFICATION_MODEL_ID` | Foundry Claude deployment names (chat / classification gate) | `claude-opus-5` / `claude-haiku-4-5` |
| `AZURE_EMBEDDING_MODEL_ID` | Azure OpenAI `text-embedding-3` deployment for memory embeddings (fail-open if absent; `''` to skip) | `text-embedding-3-small` |
| `AZURE_FOUNDRY_BASE_URL` | Override the derived `…/anthropic/v1` Foundry chat endpoint | derived from resource |
| `AZURE_API_VERSION` | Azure OpenAI API version (embeddings only) | SDK default (`preview`) |
| `BEDROCK_MANTLE_MODEL_ID` / `BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` | **Bare** Bedrock IDs for mantle (chat / classification gate); no fallback to the prefixed `BEDROCK_*` vars | `anthropic.claude-opus-5` / `anthropic.claude-haiku-4-5` |
| `BEDROCK_MANTLE_EMBEDDING_MODEL_ID` | Memory embeddings under mantle — Titan on bedrock-runtime, since mantle serves none (`''` to skip) | `amazon.titan-embed-text-v2:0` |
| `BEDROCK_MANTLE_BASE_URL` | Override the derived `…/anthropic/v1` mantle chat endpoint | derived from region |
| `OPENAI_MODEL_ID` / `OPENAI_CLASSIFICATION_MODEL_ID` | OpenAI model IDs (chat / classification gate). The provider pins gate calls to `reasoningEffort: 'none'` and omits their `temperature`, keeping the gates' tiny token budgets valid on GPT-5.x | `gpt-5.6-sol` / `gpt-5.6-luna` |
| `OPENAI_EMBEDDING_MODEL_ID` | Memory embeddings under openai — a `text-embedding-3` model truncated to 1024 dims (`''` to skip) | `text-embedding-3-small` |
| `OPENAI_BASE_URL` | Override the direct chat/embeddings endpoint (must serve the Responses API; does not move the Realtime socket) | SDK default (`https://api.openai.com/v1`) |
| `CONTEXT_WINDOW_TOKENS` | Input-context window assumed for the context-usage indicator; only needed for a model the catalog doesn't know | derived from the model ID |
| `MODELS_DEV_URL` | Opt in to refreshing the model-window catalog from a registry once at startup (e.g. `https://models.dev/api.json`); unset = no outbound call, bundled catalog only | — (disabled) |
| `COMPACTION_THRESHOLD_PERCENT` | Auto-compact a thread when context occupancy reaches this percent of the model's window; `0` disables | `90` |
| `COMPACTION_TAIL_MESSAGES` | Newest messages kept out of compaction (sent verbatim) | `6` |
| `ATTACHMENT_TTL_HOURS` | How long attachment content (the media file under `<data dir>/media`) is kept before the hourly sweep deletes it; the metadata stub survives, so history keeps showing the file as *content expired*. A non-positive or unparseable value falls back to the default | `168` (7 days) |
| `OPENAI_API_KEY` | Enables [voice meetings](docs/voice-meetings.md), and drives chat when `LLM_PROVIDER=openai` (required direct; not needed through Nexus). The Realtime WebSocket is **never routed through Nexus** — the openai mount routes POST only, so the socket goes direct to `api.openai.com`; may be a `__nexus_cred:…__` sentinel since it only ever rides a header | — (meeting tools unregistered) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the in-meeting voice. Pinned to a snapshot rather than the moving `gpt-realtime` alias, so a new snapshot cannot change turn-taking under a live deployment | `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Voice name | `marin` |
| `OPENAI_REALTIME_REASONING_EFFORT` | How hard the in-meeting model thinks before answering or picking a tool (`minimal`…`xhigh`). The Realtime API's own default is `low` — right for a voice agent that reads out an order status, wrong for one holding shell, kubectl and its own configuration, so this defaults to `high`. Paid for in latency, which in a call is silence in a room: `[Meeting:Latency]` logs the level in force beside the figure so levels can be compared. `''` sends no setting and takes the API default | `high` |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcriber that decides whether the agent was addressed — never fed to the model. On for every call, since the mode can change mid-session and an utterance already past can't be transcribed retroactively (bills per minute). `gpt-live-transcribe` because it is the only model that both streams partials *and* accepts `keywords`; the agent's name and the room's roster are seeded through that, and a model without it drops them silently | `gpt-live-transcribe` |
| `OPENAI_NOISE_REDUCTION` | Server-side noise reduction over meeting audio before turn detection and transcription see it (`off` \| `near_field` \| `far_field`). **Off by default**, which is not the obvious choice: `far_field` describes the humans' microphones, not this input — what arrives is Meet's mixed output, already suppressed, echo-cancelled and levelled per participant, so reducing again is a second pass over a cleaned mix. Under `far_field` a live agent went minutes without reacting to a person in the room while answering the other agent's much louder synthesized voice — an adaptive floor lifted by loud speech suppresses a quieter human as noise. Side by side on the same room, reduction off registered seven utterances to `far_field`'s two. Mishearing is recoverable; not hearing is not. `near_field` is untested — try it before `far_field` if a room proves too noisy | `off` |
| `GOOGLE_BOT_EMAIL` / `GOOGLE_BOT_PASSWORD` | Google account the meeting bot signs in as. **Effectively required** — Meet auto-denies automated anonymous guests (`CreateMeetingDevice` 403, host never prompted). Profile persisted under `<DATA>/meeting-browser-profile`. The password **cannot** be a `__nexus_cred:…__` sentinel, unlike every other secret here: sentinels are rewritten on the wire and only work for a header, while this is typed into a sign-in form over TLS to Google — the runtime needs the real value in memory. Google Meet exposes no bot or service-account API, so a real browser signed into a real account is the only way in; use a dedicated account | — |
| `MEETING_TRANSCRIPT_LOGGING` | Whether a call's speech may reach the log (`off` \| `full`), read at log time by `services/meeting/transcript-log.ts`. `off` writes the gate verdict, item id (which is what pairs a partial verdict with the final one, at either setting), mode and the keyword *count*; `full` adds the sentence, the roster and the gate model's own reasoning. **Off by default** — a call is unauthenticated third-party speech and the log outlives it. A variable rather than a log level so that raising verbosity for an unrelated problem cannot start recording the room as a side effect. Unrecognised values (including `''`) fall back to `off`, unlike `OPENAI_REALTIME_REASONING_EFFORT` where `''` is meaningful. Nothing here reaches product telemetry at either setting. It also drives the addressed-gate call's Langfuse tracing (`recordInputs`/`recordOutputs` off under `off`, via `langfuseTelemetry`'s `recordContent` option), since that call's prompt *is* the sentence and a trace outlives a log — every other model call traces unchanged | `off` |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait to be admitted from the waiting room, counted from when the join request goes in (reaching the lobby is budgeted separately) | `300` |
| `MEETING_LOCAL_ADDRESSED_READ` | Run the local grammar read in front of the addressed gate. Off: it can only fail by answering when nobody addressed the agent, and a fast classification model makes the saving too small to pay for that. On for a slow gate | `false` |
| `MEETING_FOLLOW_UP_WINDOW_MS` | How long after the agent's turn ends anybody in the call may follow up without saying its name. Closes early when the conversation moves on. `0` disables; no longer needs speaker attribution, since eligibility is about what was said | `8000` |
| `MEETING_FOLLOW_UP_SHADOW_JUDGE` | Judge an answered follow-up after the fact, to measure the window's precision. One background classification call per accept; nothing waits for it | `true` |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (optional, enables LLM tracing) | — |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — |
| `LANGFUSE_BASE_URL` | Langfuse server URL | `http://localhost:3100` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector for product telemetry (unset/empty = disabled) | baked into published images via `vars.OTEL_EXPORTER_OTLP_ENDPOINT`; empty otherwise |
| `OTEL_EXPORTER_OTLP_API_KEY` | Collector auth, sent as `x-api-key` header | baked into published images as a file (`/app/.otel-api-key`, exported by `start.sh`) from `secrets.OTEL_EXPORTER_OTLP_API_KEY`; empty otherwise |
| `DEPLOYMENT_ENVIRONMENT` | Tags OTel records (production \| staging \| development) | `production` in published images, `development` otherwise |
| `SERVICE_VERSION` | Build identifier emitted as the OTel `service.version` resource attribute | release tag (e.g. `v2026.6.18060952`) for release-production.yml; `canary-<sha>` for release-canary.yml; the image tag (`pr-<n>-<slug>`) for docker-build.yml; empty otherwise |

## Chat Flow

There are two entry points for chat, both handled locally by the agent-runtime:

1. **WebSocket**: Client -> Backend (JWT verify + proxy) -> Agent-runtime WS gateway -> `conversationEngineService.chat()` (local, no HTTP)
2. **Slack**: Bolt Socket Mode message -> `conversationEngineService.chat()` (local, no HTTP)

In both cases, `conversationEngineService.chat()` manages the thread, **iterates `invokeStream()` directly** (no queue, no HTTP), and `messageDeliveryService.publish()`'es each text-bearing step the moment its `onStepFinish` fires. Each delivery uses a `channelContext` that scopes the publish to the originating channel only (WebSocket or Slack), so users see intermediate text from multi-step responses in real time instead of one big block at the end.

The engine keeps a **one-step buffer**: it can't know a step is the last text step until the next step (or stream end) arrives, so the last publish is the one that carries the accumulated UI `blocks` and the `shouldShowFeedback` decision. Earlier steps publish with `includeFeedback: false` and no blocks.

The management `POST /agents/chat` endpoint remains available for internal/debug use.

### Turn Steering (mid-turn messages)

There is **one live turn per thread**. `chat()` decides offer-vs-own before it
stores the message (synchronously, so two messages in the same tick can't both
conclude they own the turn):

`threadTurnService.claimOrOffer(threadId, text, attachmentIds)` is that decision,
in one synchronous act:

1. **Offer** — it returns `null` when a turn already **claims** the thread. The
   message is stored (it is real history) and `chat()` returns
   `{ steered: true }` without calling the LLM. The claiming turn drains it in
   `invokeStream`'s `prepareStep` and appends it as a user message, so the model
   sees it on its next step and can change course.
2. **Own** — otherwise it returns a `ThreadClaim`, taken **before** this call
   stores anything or waits for the mutex, and the turn runs inside
   `claim.run(async () => …)`. `claim.run()` and `threadTurnService.run()` share
   the one per-thread mutex; the goal loop uses the latter, so a goal turn
   serializes but isn't steerable — an autonomous turn is not redirected by a
   user message.
3. **Coalesce** — messages that land after the turn's last step boundary are
   answered by **one** follow-up turn (not one per message) with
   `appendPrompt: true`, since their text sits earlier in history than the
   previous turn's replies. A canceled turn runs no follow-up.

**Why a claim rather than "is it invoking right now".** The claim is what makes
the decision atomic. A turn that owns a thread does real work before it reaches
the model — it stores the message and reads the agent, two DB round trips — so any
"is it busy" signal derived from the invocation itself starts *after* that work,
and a message landing in between would find the thread free and start a turn of
its own. Only a marker taken in the same tick as the decision closes that, which
is what the claim is. The message row is still written before the mutex wait, so
its arrival order holds; the turn awaits that write inside `claim.run()`, where a
failed write releases the thread instead of leaving it taken.

Why it matters: without this, a mid-turn message started a second turn that
queued behind the per-thread lock, and by the time it ran the first turn had
appended its own replies — leaving the history ending on an assistant turn, which
Bedrock/Anthropic reject ("This model does not support assistant message prefill.
The conversation must end with a user message."). Each failed turn's error reply
then terminated the next queued turn's history, cascading.

The claim is the only route to the inbox and it dies with the exchange, so the
ordering is encoded in the primitive rather than being something each call site
has to know. Two guarantees come with it:

- **The exchange ends and the thread frees in one synchronous act.**
  `claim.drainOrRelease()` is the loop's exit test: it hands back what is pending,
  or releases when the inbox is empty. No message can be accepted by a claim that
  is about to end.
- **Nothing leaks across turns.** Whatever is still pending when a claim releases
  is cleared — a turn that ends without draining (a cancel, a throw) loses its own
  leftovers rather than having them injected mid-step into the *next* turn, which
  reads them from history anyway.
- **A hand-over is undone if storing it fails.** The message reaches the inbox
  before it is stored — it has to, so hand-over and decision are one act — so
  `chat()` calls `threadTurnService.withdraw(threadId, pending)` when the write
  rejects. Otherwise the running turn would answer text that never became
  history, and the next turn would read a reply to nothing. Best effort by
  nature: if the turn already drained the message, `withdraw()` returns false and
  the engine logs it, because the model has already seen it.

Transports never touch the thread-turn service. The Slack adapter just calls
`chat()`. The WS gateway, which keeps its own per-user queue, calls `chat()` with
`steerOnly: true` first: that hands over if a turn owns the thread and otherwise
stores nothing and claims nothing, so the gateway can fall back to its queue
unchanged.

Steer-only requires a `threadId` — the gateway's `offerToLiveTurn()` takes a
`ThreadedMessage`, so the probe can't have `chat()` resolve (and create) a thread
for a message it then neither stores nor answers. The TUI therefore pins its
thread id at launch (`startNewSession()`) and adopts one from a `thread` envelope
as a backstop; without an id a mid-turn message lands in the gateway queue
instead of steering — answered late rather than reported.

**Reachable from Slack and the terminal UI; not from the web.** The TUI composer
stays live for the whole turn — the in-flight spinner moved out of the input box
into `ThinkingRow`, above it — so Enter sends into the running turn. Slack gates
nothing. The **web** composer still swaps send for a stop button while `isPending`
(`ChatInput.tsx`), which also gates its Enter path, so a user cannot send
mid-response there; opening it is its own change, and `docs/web-ui.md` describes
only what that UI actually does.

Keeping the TUI composer mounted for a whole turn cost one thing worth knowing.
Ink dispatches `useInput` handlers child-before-parent, so the text input sees a
Ctrl chord before `App` does, and `ink-text-input` only filtered Ctrl+C — Ctrl+O
inserted a literal `o`. The old spinner/input swap remounted the child on every
turn boundary and re-registered it last, which accidentally masked that. The
composer is now `cli/src/components/TextInput.tsx`, a small vendored fork that
ignores every Ctrl chord, so the ordering no longer matters.

**Trailing-user tripwire.** `warnOnTrailingAssistant()` (in `invoke.ts`) runs
before every `generateText` call — initial, per-step, and early-stopping — and
logs a warning plus a single `invocation trailing assistant` telemetry event per
invocation when the array does not end on a `user` (or `tool`) message. Detection
only, deliberately no repair: the point is to prove steering keeps the invariant,
and a silent fix-up would mask a regression. Note a trailing `tool` message is
fine — both the Bedrock and Anthropic converters group a run of `tool`/`user`
messages into one provider-level user turn.

## Heartbeat/Cron Flow (In-Process)

Heartbeat and cron services call `invoke()` (the drain wrapper) directly in-process, no HTTP. They need the **full aggregated response** before they can act — both run a DELIVER/SUPPRESS classification gate over the complete text (`lib/classification-gate.ts`; the cron gate is instruction-aware, see `prompts/cron-prompt.ts`) — so per-step streaming would not buy anything here. Structured budget metadata flows through as `InvokeResponse.error` (populated when any step carried `error: { type: 'budget_exceeded' }`).

Results are delivered to users via local `messageDeliveryService.publishToActiveThread()`.

## Step Limit and Early Stopping

The `generateText()` call inside `invokeStream()` is capped at **100 steps** (`STEP_LIMIT` in `constants.ts`) using `stopWhen: stepCountIs(STEP_LIMIT)`. This prevents runaway agent loops.

When the step limit is reached, a follow-up `generateText()` call is made **without tools**, appending the `EARLY_STOPPING_PROMPT` (from `prompts/early-stopping-prompt.ts`). This asks the model to summarize its findings so far and produce a useful final response for the user. The summary is pushed onto the same step channel as a final `InvokeStep`, so streaming consumers (chat) see it as just another step and the `invoke()` drain wrapper aggregates it into the response like any other step.

### Shared Constants (`constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `STEP_LIMIT` | `100` | Maximum number of tool-use steps before stopping |
| `MAX_OUTPUT_TOKENS` | `16000` | Max tokens per `generateText()` call |

The main `invokeStream()`/`invoke()` calls send no sampling params (`temperature`, `top_p`, `top_k`) at all — Opus 4.7 and later reject them (per Anthropic's Bedrock migration guide), so the invoke path omits them entirely rather than tracking which model version accepts what. The classification gates apply the same rule through the provider seam: `getGateRequest().samplingParams` is `{ temperature: 0 }` on the Claude vendors (Haiku continues to accept it) and `{}` on openai, whose GPT-5.x models reject or strip an explicit temperature.

## LLM Error Handling

`lib/llm-errors.ts#buildErrorStep(error)` is the **single owner** of LLM/runtime error → user-facing text. It distinguishes Nexus RFC 7807 `budget-exceeded` 429s (returns a friendly "spending limit reached" message and tags the step with `error: { type: 'budget_exceeded', detail }`) from generic errors (returns a "I encountered an error…" step tagged `error: { type: 'generic', detail }`, with the response body's `detail` field when present). The SDK wraps retried failures with a `lastError` field — `buildErrorStep` unwraps it before classifying. The cron scheduler uses the tag to route error results **around** the DELIVER/SUPPRESS gate: an error message is never "nothing to report", so it always delivers.

It's used only inside `invokeStream()`'s catch paths (context-fetch failure, `generateText` rejection). Errors are pushed onto the step channel rather than thrown, so consumers don't need a separate error-handling path: chat just sees a final friendly step and delivers it; `invoke()` aggregates the text and surfaces the structured `error` field on `InvokeResponse` so heartbeat/cron can detect budget exhaustion programmatically.

**No error is logged raw.** `logger` installs one global pino serializer for the `err`
key (`lib/log-redaction.ts`), and it is an **allow-list**: `name`/`message`/`stack`/
`code`/`errno`/`syscall`/`statusCode`/`url`/`isRetryable`/`reason`, plus `cause`,
`lastError` and each entry of `errors` reduced to `{ name, message }` (that list
bounded at five), plus `$metadata.httpStatusCode` lifted out as `statusCode` since an AWS
SDK error carries its status nowhere else. Every other field is dropped and merely *named*
in a `redacted: [...]` array. No request body, no response body and no headers reach a log;
`message` is kept, so an error the SDK *builds* by interpolating content (a
`JSONParseError` quotes the text it could not parse) still quotes that much. Pino's default
`err` serializer copies every own property of an
error, and the AI SDK's `APICallError` hangs `requestBodyValues` (the whole prompt) and
`responseBody` off it — so a single `logger.error({ err }, …)` wrote the conversation,
the system prompt and any provider tokens in the headers into the log. Allow-list rather
than deny-list because the SDKs add fields over time and a new one must not leak by
default; one serializer rather than per-call-site edits because the risk is a *future*
`logger.error(err)`, not just today's. Pass errors as `err` (either
`logger.error(err, msg)` or `logger.error({ err }, msg)`) — a message built by
interpolating an error into a template string bypasses this entirely.

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

- **Model**: the fast classification model via `getGateRequest()` (from `lib/classification.ts`, which goes through `createProvider()` and also carries the vendor's `classificationProviderOptions`), configured by `BEDROCK_CLASSIFICATION_MODEL_ID` (or `AZURE_CLASSIFICATION_MODEL_ID` on Azure, `BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` on bedrock-mantle, `OPENAI_CLASSIFICATION_MODEL_ID` on openai).
- **Input**: The heartbeat response text and the last alert context (text + how long ago it was sent, formatted via `formatTimeAgo`).
- **Output**: A single word -- `DELIVER` or `SUPPRESS`. Uses `maxOutputTokens: 16` (the OpenAI Responses API minimum — a cap, so free on the Claude vendors) and the provider's gate sampling params: `temperature: 0` on the Claude vendors for determinism, omitted entirely on openai (GPT-5.x rejects or strips it), with `reasoningEffort: 'none'` pinned there so reasoning tokens can't eat the budget.
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

## Agent Plugins

The runtime also implements **Agent Plugins 1.0.0** ([agent-plugins.org](https://agent-plugins.org)) —
a portable folder format that packages skills together with the MCP servers they
need. The standard defines exactly two component types and nothing else.

- **Layout.** `<DATA>/plugins/<id>/` (override `PRISM_PLUGINS_DIR`) holding a
  required `plugin.json`, an optional `skills/`, and an optional `mcp.json`. The
  directory name is the plugin id; the manifest `name` is display only, so the
  id never depends on a lossy slugification. Installation is out of band, as for
  skills — drop a folder in, and the catalog refreshes on the plugins-dir mtime.
- **`plugin.json`** (`plugin-catalog.service.ts`) is a closed schema: `$schema`
  and `name` required, eight optional metadata fields. `$schema` is a **version
  gate matched by exact string against a local allowlist and never fetched**
  (spec §5.2). Three outcomes are distinguished — supported, an Agent Plugins
  version we don't implement, and not an Agent Plugins manifest at all — because
  they are different problems with different fixes. Unknown top-level fields and
  a non-object `extensions` are *reported and ignored*; anything else rejects
  that plugin alone.
- **Skills** are one more root in `skillCatalogService.roots()`, appended after
  the global dir and tagged `source: 'plugin'` + `pluginId`. Plugin roots rank
  **last**, so a plugin can add a skill but never shadows a workspace or global
  one. Everything downstream (the `skill` tool, its emptiness gate, both REST
  endpoints, the `# Skills` prompt section) picks that up unchanged.
- **`# Plugins` prompt section** (`buildPluginsSection` in `context-builder.ts`)
  carries what nothing else can: which plugin a skill or tool came from, the
  `<plugin>__<server>__<tool>` naming scheme (the tools block has the names but
  can't explain them), and the plugins dir path, which is what makes "the agent
  installs a plugin itself" reachable. Deliberately not a second skill listing —
  plugin skills are named, not re-described, since `# Skills` already pays for
  their descriptions. Collapses to one sentence when no plugin is installed, so
  the common case stays cheap. Cacheable on the same terms as `# Skills`.
- **MCP servers** (`plugin-mcp-config.ts` parses, `plugin-mcp.service.ts`
  connects). stdio uses `@ai-sdk/mcp/mcp-stdio`; the spec's `streamable-http` is
  translated to the SDK's `http` at the parse boundary. `client.tools()` is
  called **once at connect**, not per turn — that keeps one child process per
  server instead of per turn and makes the tools block byte-identical across
  turns and across the chat/compaction paths, which is what the prompt cache
  needs. Connection is lazy and coalesced; a failed server sticks until its
  `mcp.json` changes. `shutdownAll()` runs from `index.ts` so a SIGTERM doesn't
  orphan children.
- **Deliberate leniencies, both reported as diagnostics.** `mcp.json` may omit
  `$schema` (assumed 1.0.0) and a server may omit `type` (assumed `stdio`),
  though the spec's schema requires both. Every `mcp.json` written for another
  agent omits `$schema`, and refusing the file over it loads zero servers while
  the plugin's skills keep working — which reads as a runtime bug, not a
  malformed file. A `$schema` that is *present* and names an unimplemented
  version is still refused: absent means unstated, present-and-different is a
  real declaration.
- **Tool names** are `<pluginId>__<serverName>__<toolName>`, capped at **64**
  characters — Bedrock Converse's `toolSpec.name` limit binds tighter than
  Anthropic's 128, and this runtime defaults to Bedrock. Over-long names are
  truncated with a digest suffix so they stay distinct and stable across
  restarts. In `collectTools()` plugin tools merge **last** behind an explicit
  guard, and `filterToolsByMode()` now wraps the *merged* map so MCP tools no
  longer bypass mode gating.
- **Failure isolation is graduated** (spec §11.3), and every level is covered by
  a test: a bad manifest skips one plugin; a bad `mcp.json` disables only MCP and
  leaves that plugin's skills loading; one bad server entry skips only itself.
- **Deliberately out of scope**, because the spec defers all of it: enable/
  disable state, a registry, signing or provenance, and reverse-domain extension
  namespaces (parsed for validity, then ignored — which is conformant).
