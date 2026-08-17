# Configuration

The runtime is configured entirely through environment variables. For a native
install they go in `~/.prism/.env` (restart the service after editing); for
Docker, pass them with `-e`. Only an LLM credential is required — everything
else has a sensible default.

## Provider selection

The runtime talks to one LLM provider per container, chosen by `LLM_PROVIDER`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLM_PROVIDER` | LLM platform: `bedrock` (AWS), `azure` (Claude via Microsoft Foundry), `bedrock-mantle` (AWS's second Bedrock inference endpoint), or `openai` (the official OpenAI API). Any other value falls back to `bedrock`. | `bedrock` |

The three Claude platforms serve **Claude** through the Anthropic Messages API
— `azure` mode runs the agent on Claude deployed in [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
(`https://{resource}.services.ai.azure.com/anthropic/v1/messages`). On Azure,
memory embeddings come from an Azure OpenAI `text-embedding-3` deployment
(Anthropic has no embedding model), defaulting to `text-embedding-3-small`;
if that deployment doesn't exist, memory embedding fails open (search
degraded, no crash).

`bedrock-mantle` targets [Amazon Bedrock's mantle endpoint](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html)
(`https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`), which AWS
runs alongside `bedrock-runtime` and recommends for new applications. Two
differences from `bedrock` matter in practice:

- **Model IDs must be bare.** Mantle has no cross-region inference profiles, so
  `anthropic.claude-opus-5` works and `us.anthropic.claude-opus-5` is rejected.
  A prefix on a per-agent override is stripped automatically, so switching an
  existing deployment over doesn't break it. Version suffixes are rejected too:
  use `anthropic.claude-haiku-4-5`, not
  `anthropic.claude-haiku-4-5-20251001-v1:0`.
- **Mantle serves no embedding models.** Memory embeddings stay on Titan over
  `bedrock-runtime`, which means AWS credentials (or Nexus) still have to reach
  regular Bedrock for that leg; set `BEDROCK_MANTLE_EMBEDDING_MODEL_ID=''` to
  skip embeddings instead.

Mantle also rejects structured outputs, Guardrails, and prompt routing, and it
draws on a separate quota pool at the same per-token price.

`openai` runs the agent on **OpenAI models** via the
[Responses API](https://platform.openai.com/docs/api-reference/responses),
direct to `api.openai.com` (or an OpenAI-compatible endpoint via
`OPENAI_BASE_URL` — it must serve `/responses`, not just `/chat/completions`).
Chat, the classification gate, and memory embeddings
(`text-embedding-3-small`, truncated to 1024 dims) all ride the one surface,
authenticated with the same `OPENAI_API_KEY` that enables
[voice meetings](voice-meetings.md) — setting it for chat also switches the
meeting tools on where the browser/audio toolchain is present.

Each platform can run **direct** or **through Nexus** (the LLM gateway).
Routing is automatic for all four: set `NEXUS_API_URL` and the runtime routes
through Nexus (`…/llm/bedrock/{region}` for Bedrock; for Azure, chat rides
`…/llm/azure/anthropic/v1` and embeddings `…/llm/azure/openai/v1`; for mantle,
chat rides `…/llm/bedrock-mantle/anthropic/{region}/v1` while embeddings stay
on the `…/llm/bedrock/{region}` mount; for OpenAI, chat, classification and
embeddings all ride `…/llm/openai/v1`), otherwise it talks to the platform
directly. Through Nexus the gateway holds the platform credentials, so no local
LLM credential is needed. The one exception is the voice-meeting Realtime
WebSocket, which always goes direct to `api.openai.com` — the Nexus openai
mount routes POST only. The credentials and model IDs below are grouped per
platform.

## Credentials

| Variable | Purpose |
|----------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | **(Bedrock, Mantle)** Bedrock API key — one credential for both AWS endpoints. On Bedrock the AI SDK auto-selects bearer auth when this is set; on mantle it is sent as the `x-api-key` header and is **required** for direct mode, which has no SigV4 path. Not needed when routing through Nexus. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **(Bedrock)** AWS SigV4 credentials, as an alternative to the bearer token. Mantle chat cannot use these, but they still serve the Titan embedding leg under `bedrock-mantle`. |
| `BEDROCK_MANTLE_BASE_URL` | **(Mantle)** Override the derived mantle chat endpoint (must end at `/anthropic/v1`). Applies to direct mode only. |
| `AZURE_API_KEY` | **(Azure)** Foundry resource key, sent as the `x-api-key` header. Required for direct mode only — when routing through Nexus the gateway holds the key for both chat and embeddings. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `AZURE_RESOURCE_NAME` | **(Azure, direct)** Foundry resource name — derives the chat endpoint `https://{resource}.services.ai.azure.com/anthropic/v1` and the embeddings endpoint `https://{resource}.openai.azure.com`. |
| `AZURE_FOUNDRY_BASE_URL` | **(Azure)** Override the derived Foundry Anthropic chat endpoint (must end at `/anthropic/v1`). |
| `OPENAI_API_KEY` | **(OpenAI)** API key, sent as a bearer header. Required for direct mode only — through Nexus the gateway holds the key. Shared with [voice meetings](voice-meetings.md): setting it also enables the meeting tools when the browser/audio toolchain is present. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `OPENAI_BASE_URL` | **(OpenAI, direct)** Override the chat/embeddings endpoint (must serve the Responses API). Does not move the voice-meeting Realtime WebSocket. |
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
| `PRISM_DATA_DIR` | Persistent data dir for [skills](skills.md), [plugins](plugins.md) and the Claude Code config. The Docker image sets this to the `/data` volume. | `/data` (Docker), else `~/.prism` |
| `PRISM_SKILLS_DIR` | Override the [skills](skills.md) directory specifically. | `<data dir>/skills` |
| `PRISM_PLUGINS_DIR` | Override the [plugins](plugins.md) directory specifically. | `<data dir>/plugins` |

`AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID` only matter on the **first** boot
with an empty database; later boots reuse the stored workspace.

[Webhooks](webhooks.md) need no environment variables — the receiver toggle and
subscriptions live in the database, managed from the Web UI. Note that the
runtime does not authenticate inbound webhook calls itself (auth is the
platform's job in front of the container), so don't expose the runtime port
directly to the internet.

## Chat verbosity

The `verbose` setting controls how multi-step chat turns are delivered:

| Mode | Behavior |
|------|----------|
| **Concise** (default, `verbose=false`) | Only the final text step of a turn is delivered to the channel. Intermediate steps are still saved, but marked internal so they stay hidden from the conversation — both live and when the thread is reloaded. The model's final message must be self-contained. |
| **Verbose** (`verbose=true`) | Every text step is delivered as it arrives — the existing streaming behavior. |

This is a per-agent database setting (not an environment variable). Set it via:

- The **Profile** page toggle in the [Web UI](web-ui.md#profile)
- `PATCH /agents/verbose` with `{ "verbose": true | false }`
- Asking the agent to change it (the `update_settings` tool accepts `verbose`)

Because persistence is unchanged (every step is always stored — concise mode only
flags the intermediate ones as internal), the model's context window is correct
regardless of mode: switching between concise and verbose has no effect on the
agent's memory of past turns. The setting applies to **new** turns only —
toggling `verbose` does not reveal steps that were already hidden, nor hide steps
that were already delivered.

## Models

Which set applies depends on `LLM_PROVIDER`. Bedrock model IDs are Bedrock model
identifiers; **Azure model IDs are Foundry deployment names** (which default to
Claude model IDs when you deploy without renaming); **mantle model IDs are bare
Bedrock identifiers** — same names, no `us.`/`eu.`/`global.` prefix; **OpenAI
model IDs are plain OpenAI API model names**.

| Variable | Purpose | Default |
|----------|---------|---------|
| `BEDROCK_MODEL_ID` | **(Bedrock)** Main model (the agent's reasoning loop) | `us.anthropic.claude-opus-5` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | **(Bedrock)** Fast model for the [heartbeat](heartbeat.md) and [scheduled-task](scheduled-tasks.md) DELIVER/SUPPRESS gate | a Claude Haiku model |
| `BEDROCK_EMBEDDING_MODEL_ID` | **(Bedrock)** Embedding model for [searchable memory](memory.md) | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | **(Bedrock)** AWS region for Bedrock | `us-east-1` |
| `AZURE_MODEL_ID` | **(Azure)** Main model — a Claude chat deployment name | `claude-opus-5` |
| `AZURE_CLASSIFICATION_MODEL_ID` | **(Azure)** Fast Claude deployment for the heartbeat gate | `claude-haiku-4-5` |
| `AZURE_EMBEDDING_MODEL_ID` | **(Azure)** Azure OpenAI embedding deployment (a `text-embedding-3` model; truncated to 1024 dims to match the memory index). The deployment must exist on the resource, else memory embedding fails open (no vector). Set to `''` to skip embeddings entirely. | `text-embedding-3-small` |
| `AZURE_API_VERSION` | **(Azure)** Azure OpenAI API version (embeddings only) | SDK default (`preview`) |
| `BEDROCK_MANTLE_MODEL_ID` | **(Mantle)** Main model — a **bare** Bedrock ID | `anthropic.claude-opus-5` |
| `BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` | **(Mantle)** Fast **bare** Bedrock ID for the heartbeat gate. Unversioned — mantle 404s the `…-20251001-v1:0` shape `bedrock-runtime` uses. | `anthropic.claude-haiku-4-5` |
| `BEDROCK_MANTLE_EMBEDDING_MODEL_ID` | **(Mantle)** Embedding model, served by Titan on `bedrock-runtime` — mantle has none of its own. Set to `''` to skip embeddings entirely. | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | **(Mantle)** Region for both the mantle host and the Titan embedding leg | `us-east-1` |
| `OPENAI_MODEL_ID` | **(OpenAI)** Main model (the agent's reasoning loop) | `gpt-5.6-sol` |
| `OPENAI_CLASSIFICATION_MODEL_ID` | **(OpenAI)** Fast model for the heartbeat gate. The gates pin it to `reasoningEffort: 'none'` (the SDK name for the API's `reasoning.effort`) and send no `temperature` — GPT-5.x models reject or strip an explicit temperature, and reasoning tokens would eat the gates' tiny output budgets. | `gpt-5.6-luna` |
| `OPENAI_EMBEDDING_MODEL_ID` | **(OpenAI)** Embedding model (a `text-embedding-3` model; truncated to 1024 dims to match the memory index). Set to `''` to skip embeddings entirely. | `text-embedding-3-small` |
| `CONTEXT_WINDOW_TOKENS` | Input-context window (tokens) to assume for the agent's model. Only needed when the catalog doesn't recognize it. Ignored unless a positive integer. | derived from the model ID |
| `MODELS_DEV_URL` | Refresh the model-window catalog from a registry once at startup. Unset means no outbound call, bundled catalog only. | — (disabled) |
| `COMPACTION_THRESHOLD_PERCENT` | Auto-[compact](compaction.md) a conversation when its context occupancy reaches this percent of the model's window. `0` disables auto-compaction; out-of-range values fall back to the default. | `90` |
| `COMPACTION_TAIL_MESSAGES` | How many of the newest messages stay out of compaction and remain in the context verbatim. `0` is allowed. | `6` |

The mantle **chat and classification** variables deliberately do **not** fall
back to their `BEDROCK_*` counterparts, since those carry a cross-region prefix
mantle rejects. `BEDROCK_MANTLE_EMBEDDING_MODEL_ID` *does* inherit
`BEDROCK_EMBEDDING_MODEL_ID`: that leg runs on `bedrock-runtime` regardless of
provider, and Titan IDs carry no prefix.

The main model can also be set per-agent at runtime (Web UI Profile, the TUI
`/model` command, or by asking the agent), which overrides the env default. On
Azure, per-agent overrides are Foundry deployment names. On mantle, a stored
override that carries a `us.`/`eu.`/`global.` prefix has it stripped at request
time, so the same value keeps working if you switch back to `bedrock`.

**Heartbeat and scheduled (cron) runs** can each use their own model, set the
same ways — the Web UI Profile page or the TUI `/heartbeat-model` /
`/cron-model` commands. Both default to empty and fall back to the main model
(which in turn falls back to the active platform's main model), so you can run
routine heartbeats on a cheaper model while chat stays on a stronger one. The
DELIVER/SUPPRESS gate (heartbeat and scheduled tasks) always uses the active
platform's classification model (`BEDROCK_CLASSIFICATION_MODEL_ID` on Bedrock,
`AZURE_CLASSIFICATION_MODEL_ID` on Azure,
`BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` on mantle,
`OPENAI_CLASSIFICATION_MODEL_ID` on OpenAI), independent of this.

### Context-window size

The **[Web UI](web-ui.md#chat)** and **[Terminal UI](terminal-ui.md#status-bar)**
show how much of the model's context window a conversation has used. None of
the platforms report a model's window size, so the runtime reads it from a
bundled catalog of window sizes sourced from
[models.dev](https://models.dev). That bundled copy needs no network and is the
only source by default.

Set `MODELS_DEV_URL=https://models.dev/api.json` to also refresh the catalog once
at startup, so a model released after the build gets a real window. The refresh
never blocks or fails startup: lookups use the bundled copy until it lands, and
permanently if it doesn't. A refreshed window wins over a bundled one, but no
bundled entry is lost. Enable it deliberately — models.dev is community-maintained,
so a wrong number upstream reaches your deployment on the next boot without review.

**In a sandboxed or egress-filtered deployment, this is more than a runtime flag.**
Enabling it means allow-listing `models.dev`, and an allow-list is not per-process:
once the domain is reachable, it is reachable by the **agent's own tools** too, not
just by the startup refresh. So treat it as adding a domain of untrusted,
community-edited content to the web the agent can reach and act on — the same
review any other reachable domain would get.

In policy-governed deployments, leave `MODELS_DEV_URL` unset. Refresh the bundled
catalog instead by running `npm run generate:model-limits` and committing the
result: the windows still get current, the diff is reviewed by a person before it
ships, and no new domain becomes reachable at runtime.

When a model is in neither layer the indicator is hidden rather than guessed. That
is most likely on Azure, where model IDs are deployment names you chose:
`AZURE_MODEL_ID=my-opus-deploy` can't appear in any catalog. Set
`CONTEXT_WINDOW_TOKENS` to that model's input-context size (e.g. `1000000`) to
bring it back. It applies to every model the agent uses, so the main and heartbeat
models can't be given different windows.

The same window size drives **[automatic compaction](compaction.md)**: when a
conversation's measured occupancy reaches `COMPACTION_THRESHOLD_PERCENT` of the
window, the runtime folds older history into a summary. A model with an unknown
window auto-compacts against a conservative 1,000,000-token assumption (and a
context-overflow rejection triggers compaction directly); the indicator still
stays hidden for such models — it never renders a guessed percentage. Set
`CONTEXT_WINDOW_TOKENS` for accurate triggering and a visible meter.

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
| `NEXUS_API_URL` | Base URL of a Nexus instance, used for the LLM proxy and WebSocket authorization. When set, LLM calls route through Nexus (for any platform). It is **not** a fallback for `NEXUS_MCP_URL`. | — |

## Voice meetings

[Voice meetings](voice-meetings.md) let the agent join a Google Meet call and take
part by voice. The tools appear only when `OPENAI_API_KEY` is set **and** the host
has the browser/audio toolchain, which ships in the container image.

The voice model is OpenAI's Realtime API. It is the one model call that never
routes through the Nexus LLM gateway: the Nexus openai mount serves POST
endpoints only, and no managed-inference backend exposes a realtime voice
surface. The socket goes straight to `api.openai.com`, so an egress-filtered
deployment must allow that host (plus Google's meeting and accounts hosts, including
WebRTC UDP). The browser profile — and with it the signed-in session — is persisted
under the data dir, so sign-in happens once rather than per meeting.

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Enables voice meetings. The same key drives chat when `LLM_PROVIDER=openai` — see [Provider selection](#provider-selection). | — (disabled) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the in-meeting voice. Pinned to a snapshot so a new one cannot change behaviour under you; `gpt-realtime-mini` is materially cheaper. | `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | Voice name. | `marin` |
| `OPENAI_REALTIME_REASONING_EFFORT` | How hard the in-meeting model thinks before it answers or picks a tool: `minimal`, `low`, `medium`, `high`, `xhigh`. The API's own default is `low`, which suits a voice agent that reads out an order status; the model in a call here holds the agent's real toolset — shell, kubectl, integrations, its own configuration — so this defaults higher. The cost is latency, and latency in a call is silence in a room, so lower it if the pause is more noticeable than the mistakes it prevents. Set empty to send no setting and take the API's default. | `high` |
| `GOOGLE_BOT_EMAIL` | Google account the agent signs into for meetings. **Effectively required**: Google auto-denies automated anonymous guests, so without this the agent reaches the lobby and is refused. Use a dedicated account. | — |
| `GOOGLE_BOT_PASSWORD` | Password for that account. **Must be the real password in plain text — a credential sentinel does not work here.** A sentinel is rewritten on the wire by the proxy, which only works for a secret sent as an HTTP header; this one is typed into Google's sign-in form by the browser, over TLS to Google, so the runtime has to hold the actual value. A deliberate trade-off: Google Meet has no bot or service-account API, so being in a call means driving a real browser signed into a real account. Treat it accordingly — a dedicated account with nothing else attached to it. Accounts with a phone/hardware challenge or enforced SSO cannot be signed in unattended. | — |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcriber used to decide whether the agent was spoken to — never fed to the model, which hears audio. Runs on every call: a third person can join at any moment, and an utterance already past cannot be transcribed after the fact. Billed per minute of audio, a small fraction of the Realtime audio rate for the same minute. The default is the only model that both streams as a sentence unfolds *and* accepts `keywords`, which is how the agent's own name and the other participants' names are given to it — a name it mishears is a summons it misses. Changing this to a model without `keywords` silently drops those hints. | `gpt-live-transcribe` |
| `OPENAI_NOISE_REDUCTION` | How much noise reduction OpenAI applies to the meeting audio before deciding someone has spoken: `off`, `near_field`, or `far_field`. It is off by default, which sounds backwards for a room full of people — but the audio the agent receives is Google Meet's finished mix, already cleaned and levelled for every participant, so reducing it a second time mostly removes the quiet voices. With reduction on, an agent in a live call stopped responding to a person in the room for minutes at a time while still answering the other agent's much louder synthetic voice. Turn it on only if a particular room proves too noisy, and try `near_field` before `far_field`. | `off` |
| `MEETING_TRANSCRIPT_LOGGING` | Whether what is said in a call may appear in the runtime's log: `off` or `full`. `off` writes the gate's verdict, the utterance it belongs to, the mode in force and the *number* of names given to the transcriber — no words and no attendee names. `full` adds the sentence itself, the roster and the gate model's own reasoning. Off by default because a meeting is not an authenticated surface: the room did not agree to be written into a log that outlives the call, and a mangled name means the recorded words may not even be theirs. A setting of its own rather than a log level, so that turning up logging to chase an unrelated problem never starts recording the room by accident. Anything unrecognised (including empty) is treated as `off`. See [Voice meetings](voice-meetings.md#what-ends-up-in-the-log). | `off` |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call, so a meeting nobody ended can't hold a browser and a metered socket open. Junk or non-positive falls back to the default. | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait in the waiting room for a host to admit the agent, counted from when the join request goes in (reaching the lobby is budgeted separately). | `300` |

## Observability

All optional; each is off until its variable is set. Langfuse traces every LLM
call (model, tokens, tool calls, latency), with prompts and completions included
— the one exception is the in-meeting call that decides whether the agent was
named, whose content follows
[`MEETING_TRANSCRIPT_LOGGING`](voice-meetings.md#what-ends-up-in-the-log) because
it is a sentence somebody said out loud. OpenTelemetry exports product telemetry
to a collector; that surface carries no prompts at all. Structured logs (Pino)
are always on, and no error written to them carries a request or response body.

| Variable | Purpose | Default |
|----------|---------|---------|
| `LANGFUSE_SECRET_KEY` | Enables Langfuse LLM tracing when set | — |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — |
| `LANGFUSE_BASE_URL` | Langfuse server URL | `http://localhost:3100` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables OpenTelemetry export when set | — |
| `OTEL_EXPORTER_OTLP_API_KEY` | Collector auth, sent as `x-api-key` | — |
| `DEPLOYMENT_ENVIRONMENT` | Tags OTel records (`production` / `staging` / `development`) | `production` (published images) |

With OpenTelemetry enabled, the runtime emits an `agent started` event once per
boot describing the deployment: the LLM provider, whether calls route through
Nexus, the model identifiers, on/off flags for Slack, Nexus, the external MCP
server and Langfuse, the host shape (packaged binary or not, Node version,
platform, architecture), and counts of cron tasks, installed skills, installed
plugins and
subagents. Like
every other product event, it carries only identifiers, flags and counts — never
credentials, URLs, file paths, or message content.

## Installer variables

These affect the native [installer](installation.md), not the running agent:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PRISM_HOME` | Install directory | `~/.prism` (`%USERPROFILE%\.prism`) |
| `PRISM_HTTP_URL` | Runtime URL the [`prism` TUI](cli-reference.md) connects to | `http://localhost:3003` |
