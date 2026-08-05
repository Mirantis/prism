# Configuration

The runtime is configured entirely through environment variables. For a native
install they go in `~/.prism/.env` (restart the service after editing); for
Docker, pass them with `-e`. Only an LLM credential is required — everything
else has a sensible default.

## Provider selection

The runtime talks to one LLM provider per container, chosen by `LLM_PROVIDER`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLM_PROVIDER` | LLM platform: `bedrock` (AWS), `azure` (Claude via Microsoft Foundry), or `bedrock-mantle` (AWS's second Bedrock inference endpoint). Any other value falls back to `bedrock`. | `bedrock` |

All three serve **Claude** through the Anthropic Messages API — `azure`
mode runs the agent on Claude deployed in [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
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

Each platform can run **direct** or **through Nexus** (the LLM gateway).
Routing is automatic for all three: set `NEXUS_API_URL` and the runtime routes
through Nexus (`…/llm/bedrock/{region}` for Bedrock; for Azure, chat rides
`…/llm/azure/anthropic/v1` and embeddings `…/llm/azure/openai/v1`; for mantle,
chat rides `…/llm/bedrock-mantle/anthropic/{region}/v1` while embeddings stay
on the `…/llm/bedrock/{region}` mount), otherwise it talks to the platform
directly. Through Nexus the gateway holds the platform credentials, so no local
LLM credential is needed. The credentials and model IDs below are grouped per
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
Bedrock identifiers** — same names, no `us.`/`eu.`/`global.` prefix.

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
`BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` on mantle), independent of this.

### Context-window size

The **[Web UI](web-ui.md#chat)** and **[Terminal UI](terminal-ui.md#status-bar)**
show how much of the model's context window a conversation has used. Neither
Bedrock nor Microsoft Foundry reports a model's window size, so the runtime reads
it from a bundled catalog of Claude window sizes sourced from
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
| `NEXUS_API_URL` | Base URL of a Nexus instance, used for the LLM proxy and WebSocket authorization. When set, LLM calls route through Nexus (for either platform). It is **not** a fallback for `NEXUS_MCP_URL`. | — |

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

With OpenTelemetry enabled, the runtime emits an `agent started` event once per
boot describing the deployment: the LLM provider, whether calls route through
Nexus, the model identifiers, on/off flags for Slack, Nexus, the external MCP
server and Langfuse, the host shape (packaged binary or not, Node version,
platform, architecture), and counts of cron tasks, installed skills and
subagents. Like
every other product event, it carries only identifiers, flags and counts — never
credentials, URLs, file paths, or message content.

## Installer variables

These affect the native [installer](installation.md), not the running agent:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PRISM_HOME` | Install directory | `~/.prism` (`%USERPROFILE%\.prism`) |
| `PRISM_HTTP_URL` | Runtime URL the [`prism` TUI](cli-reference.md) connects to | `http://localhost:3003` |
