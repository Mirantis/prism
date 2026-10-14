# Configuration

The runtime is configured entirely through environment variables. For a native
install they go in `~/.prism/.env` (restart the service after editing); for
Docker, pass them with `-e`. Only an LLM credential is required — everything
else has a sensible default.

## Provider selection

The runtime talks to one LLM provider per container, chosen by `LLM_PROVIDER`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLM_PROVIDER` | LLM platform: `bedrock` (AWS), `azure` (Claude via Microsoft Foundry), `bedrock-mantle` (AWS's second Bedrock inference endpoint), `openai` (the official OpenAI API), `openrouter`, `anthropic` (the first-party Anthropic API), or `litellm` (your own LiteLLM proxy). Any other value falls back to `bedrock`, and the startup log warns. | `bedrock` |

The four Claude platforms serve **Claude** through the Anthropic Messages API
— `azure` mode runs the agent on Claude deployed in [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)
(`https://{resource}.services.ai.azure.com/anthropic/v1/messages`). On Azure,
memory embeddings come from an Azure OpenAI `text-embedding-3` deployment
(Anthropic has no embedding model), defaulting to `text-embedding-3-small`;
if that deployment doesn't exist, memory embedding fails open (search
degraded, no crash).

`openrouter` is not a fifth cloud but a reseller: one API key reaches hundreds
of models from dozens of vendors, which makes it the shortest path to a running
agent (no cloud account, no IAM, no region). Its API is OpenAI-compatible, so
what distinguishes it from `openai` is where it points — `https://openrouter.ai/api/v1`
with `OPENROUTER_API_KEY`, or the `…/llm/openrouter/openai/v1` gateway mount —
and that **model IDs are `vendor/model`**: `openai/gpt-5.6-sol`,
`anthropic/claude-sonnet-5`, `google/gemini-3-pro`. A bare `gpt-5.6-sol` is not
an id OpenRouter can route.

Two things to know when pointing it at a non-OpenAI vendor. The gates send
`reasoningEffort: 'none'` and no `temperature`, which is written for the
GPT-5.x defaults; and prompt caching is left to the model, so a vendor whose
caching needs explicit markers (Anthropic, Gemini) runs uncached through
OpenRouter.

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
  `bedrock-runtime`, which means AWS credentials (or the Lens Agents gateway)
  still have to reach regular Bedrock for that leg; set
  `BEDROCK_MANTLE_EMBEDDING_MODEL_ID=''` to skip embeddings instead.

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

`anthropic` runs the agent on **Claude at the first-party Anthropic API**
(`api.anthropic.com`), authenticated with `ANTHROPIC_API_KEY`. Model IDs are
bare first-party names (`claude-opus-5`). It is the one **direct-only**
platform — no gateway mount serves `api.anthropic.com`, so the key is always
required and chat stays direct even when `NEXUS_API_URL` is set. Anthropic
serves no embedding models: memory embeddings default to OpenAI
(`text-embedding-3-small`) when `OPENAI_API_KEY` is set or when the Lens
Agents gateway holds the key (`NEXUS_API_URL` set), and are otherwise
disabled — see [Memory embeddings](#memory-embeddings).

`litellm` runs the agent on your own [LiteLLM](https://docs.litellm.ai) proxy.
Set `LITELLM_BASE_URL` to the proxy's address and `LITELLM_API_KEY` to a
LiteLLM key. On Lens Agents, choose LiteLLM as the project's inference backend
instead. The agent asks the proxy for `claude-opus-5-5` and `claude-haiku-5-5`.
If your proxy names its models differently, the startup log lists the names it
serves: set `LITELLM_MODEL_ID` and `LITELLM_CLASSIFICATION_MODEL_ID` to them.
Memory embeddings are off until you turn them on in
[Memory embeddings](#memory-embeddings).

Each platform except `anthropic` can run **direct** or **through the Lens
Agents LLM gateway**. Routing is automatic: set `NEXUS_API_URL` and chat and
classification route through the gateway (`…/llm/bedrock/{region}` for
Bedrock, `…/llm/azure/anthropic/v1` for Azure,
`…/llm/bedrock-mantle/anthropic/{region}/v1` for mantle, `…/llm/openai/v1` for
OpenAI, `…/llm/openrouter/openai/v1` for OpenRouter,
`…/llm/litellm/anthropic/v1` for LiteLLM), otherwise they go
direct. Memory embeddings route independently, on the embedding platform's own
mount — see [Memory embeddings](#memory-embeddings). A `*_BASE_URL` you set
wins over the gateway mount, so you can point a gateway deployment at your own
endpoint. Through the gateway the platform credentials are held for you, so no
local LLM credential is needed.
Voice Realtime resolves its own endpoint and credential independently of chat;
it can use managed OpenAI even when another backend handles chat. First-party
`anthropic` chat remains direct-only. The credentials and model IDs below are
grouped per platform.

## Credentials

| Variable | Purpose |
|----------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | **(Bedrock, Mantle)** Bedrock API key — one credential for both AWS endpoints. On Bedrock the AI SDK auto-selects bearer auth when this is set; on mantle it is sent as the `x-api-key` header and is **required** for direct mode, which has no SigV4 path. Not needed when routing through the Lens Agents gateway. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **(Bedrock)** AWS SigV4 credentials, as an alternative to the bearer token. Mantle chat cannot use these, but they still serve the Titan embedding leg under `bedrock-mantle`. |
| `BEDROCK_MANTLE_BASE_URL` | **(Mantle)** Override the derived mantle chat endpoint (must end at `/anthropic/v1`). |
| `AZURE_API_KEY` | **(Azure)** Foundry resource key, sent as the `x-api-key` header. Required for direct mode only — when routing through the Lens Agents gateway it holds the key for both chat and embeddings. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `AZURE_RESOURCE_NAME` | **(Azure, direct)** Foundry resource name — derives the chat endpoint `https://{resource}.services.ai.azure.com/anthropic/v1` and the embeddings endpoint `https://{resource}.openai.azure.com`. |
| `AZURE_FOUNDRY_BASE_URL` | **(Azure)** Override the derived Foundry Anthropic chat endpoint (must end at `/anthropic/v1`). |
| `OPENAI_API_KEY` | **(OpenAI)** API key, sent as a bearer header. Required for direct mode only — through the Lens Agents gateway it holds the key. Shared with [voice meetings](voice-meetings.md): setting it also enables the meeting tools when the browser/audio toolchain is present. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `OPENAI_BASE_URL` | **(OpenAI)** Override the chat/embeddings endpoint (must serve the Responses API). Does not move the voice-meeting Realtime WebSocket. |
| `OPENROUTER_API_KEY` | **(OpenRouter)** API key, sent as a bearer header. Required for direct mode only — through the Lens Agents gateway it holds the key. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `OPENROUTER_BASE_URL` | **(OpenRouter)** Override the chat/embeddings endpoint (must serve the Responses API). Defaults to `https://openrouter.ai/api/v1`. |
| `ANTHROPIC_API_KEY` | **(Anthropic)** API key, sent as the `x-api-key` header. Always required — this platform is direct-only, so there is no gateway mode to hold the key. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `ANTHROPIC_BASE_URL` | **(Anthropic)** Override the chat endpoint (must end at `/v1`). |
| `LITELLM_API_KEY` | **(LiteLLM)** LiteLLM key, sent as the `x-api-key` header. Required for direct mode only — through the Lens Agents gateway it holds the key. May be a `__nexus_cred:<uuid>__` sentinel the proxy rewrites on the wire. |
| `LITELLM_BASE_URL` | **(LiteLLM)** Your proxy's address, for example `https://litellm.example.com`. Required for direct mode only. |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`). Enables the Slack adapter; validated via `auth.test` on boot. |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`) for Socket Mode. |
| `SLACK_EXPECTED_APP_ID` | Optional safety check — the bot token's app ID must match this if set. |
| `TEAMS_APP_ID` | Microsoft Teams: the Entra app registration's client ID. All three Teams variables must be set to enable the adapter. |
| `TEAMS_APP_PASSWORD` | Microsoft Teams: the app registration's client secret. On Lens Agents, the placeholder of an OAuth client credentials credential ([Teams](teams.md)). |
| `TEAMS_APP_TENANT_ID` | Microsoft Teams: the Entra tenant of the app registration. |
| `TEAMS_PORT` | Microsoft Teams: the bot endpoint's own port, the one to publish over public HTTPS. Default `3979`. |

See **[Slack](slack.md)** and **[Microsoft Teams](teams.md)** for how the
credentials are used. Teams, unlike Slack, needs the bot port reachable over
public HTTPS (see [Microsoft Teams](teams.md#the-public-messaging-endpoint)).

## Core

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP port the runtime listens on | `3003` |
| `WEBHOOK_PORT` | HTTP port opened when the [webhook receiver](webhooks.md) is enabled | `3004` |
| `PRISM_HOST` | Network interface the runtime listens on. The default accepts connections from this machine only. Set it to `0.0.0.0` to accept them from the network — the Docker image does, so a published port works. The name is prefixed because a bare `HOST` is the machine's own hostname in some environments. | `127.0.0.1` (`0.0.0.0` in Docker) |
| `PRISM_ALLOWED_ORIGINS` | Comma-separated web origins on other sites whose pages may call the runtime, open its chat connection and use the [Computer](computer.md) desktop with pointer and keyboard. Write each as `https://app.example.com`, or `https://app.example.com:*` for any port. Set it only when an authenticating proxy is in front of the runtime: with a loopback `PRISM_HOST` the runtime refuses to start. | empty |
| `PRISM_PROGRAM_STATUS` | Whether the runtime reports the agent's state on its output, so that a terminal or [Lens Sandbox](lens-sandbox.md#the-agents-state-in-lns) can show when the agent waits for you, has finished or has failed: `on` or `off`. | `on` when the output is a terminal |
| `DATABASE_URL` | SQLite URL for the agent database. The Docker image's `start.sh` sets this to `file:/data/agent.db`; locally it resolves next to the Prisma schema. | `file:/data/agent.db` (Docker) |
| `AGENT_ID` | Pin the agent's UUID. Unset → a fresh UUID is generated on first boot and reused thereafter. | generated |
| `AGENT_NAME` | Display name on first boot | `Prism` |
| `TEAM_NAME` | Team name on first boot | `Local` |
| `OWNER_USER_ID` | Owner user ID on first boot | local sentinel UUID |
| `SHELL_WORKSPACE_ROOT` | Working directory for the agent's [shell tools](tools.md#shell) when its commands run on this machine. In a container the workspace is `/prism/workspace`. | install `workspace` dir (Docker image: `/home/node`) |
| `EXECUTION_ENVIRONMENT` | **Detected automatically — set this only to override it.** Where the agent's commands run, and where its workspace and skills are kept: `docker` (a container, with storage Docker keeps) or `local` (this machine). See [where commands run](tools.md#where-commands-run). | `docker` when a container engine answers, else `local` |
| `PRISM_DATA_DIR` | Persistent data dir for [skills](skills.md), [plugins](plugins.md), attachment media (`<data dir>/media`) and the coding agent's config. The Docker image sets this to the `/data` volume. When the agent's commands run in a container, its skills, plugins and coding-agent config are in that container under `/prism`. | `/data` (Docker image), else `~/.prism` |
| `PRISM_SKILLS_DIR` | Override the [skills](skills.md) directory specifically, when the agent's commands run on this machine. | `<data dir>/skills` |
| `PRISM_PLUGINS_DIR` | Override the [plugins](plugins.md) directory specifically, when the agent's commands run on this machine. | `<data dir>/plugins` |
| `ATTACHMENT_TTL_HOURS` | How long shared-file content is kept before the hourly sweep deletes it. The conversation keeps a *content expired* stub. See [Tools](tools.md#attachments). | `168` (7 days) |
| `TOOL_RISK_GATE_MODE` | Fast-model pre-execution evaluation for sensitive [tool calls](tools.md#risk-gate): `off`, `observe`, or `enforce`. | `off` |
| `TOOL_OUTPUT_TTL_HOURS` | How long the saved copy of an oversized tool result is kept before the hourly sweep deletes it, so the agent can search the part it wasn't shown. Copies are also deleted once the conversation they belong to has been compacted away. See [Tools](tools.md#large-tool-outputs). | `168` (7 days) |

Set `CODING_AGENT` to `claude-code` or `codex` to choose the default coding agent.
Each coding task can override it with the optional `agent` parameter; the tool lists
agents available from your credentials. When unset, the default is Claude Code,
or Codex when only Codex credentials are available. Codex also supports Bedrock credentials;
set `AWS_REGION` to a region with access to `openai.gpt-5.6-terra`.

Codex uses `CODEX_API_KEY` or `OPENAI_API_KEY` first, then a saved `auth.json` login,
then Bedrock credentials. To reuse a Codex login, set `CODEX_HOME` to its writable
configuration directory before starting Prism; the default is `<data dir>/.codex`.

Coding tasks can select a `model` tier (`small`, `medium`, `large`) and
`effort` (`low`, `medium`, `high`), including when resuming a session.
Omitted parameters keep the deployment's model and effort behavior.

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `CLAUDE_CODE_MODEL_SMALL` | Model for the Claude Code small tier | `haiku` (Bedrock: `global.anthropic.claude-haiku-5-5`) |
| `CLAUDE_CODE_MODEL_MEDIUM` | Model for the Claude Code medium tier | `sonnet` (Bedrock: `global.anthropic.claude-sonnet-5-5`) |
| `CLAUDE_CODE_MODEL_LARGE` | Model for the Claude Code large tier | `opus` |
| `CODEX_MODEL_SMALL` | Model for the Codex small tier | `gpt-5.6-luna` (Bedrock: `openai.gpt-5.6-luna`) |
| `CODEX_MODEL_MEDIUM` | Model for the Codex medium tier | `gpt-5.6-terra` (Bedrock: `openai.gpt-5.6-terra`) |
| `CODEX_MODEL_LARGE` | Model for the Codex large tier | `gpt-5.6-sol` (Bedrock: `openai.gpt-5.6-sol`) |

Set each tier to a model your account can serve; set all three overrides to keep a model
out of every tier. Blank overrides log a warning and use the default.

`AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID` only matter on the **first** boot
with an empty database; later boots reuse the stored workspace.

### What a coding task may do

Claude Code runs an edit task in its
[auto permission mode](https://code.claude.com/docs/en/permission-modes) and a plan
task in plan mode. When Claude Code refuses an action, the task result names each
refused action and its target.

Auto mode needs a model that
[supports it](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode),
and on Bedrock with Haiku 5.5 it needs Claude Code 2.1.293 or later. A tier set to any
other model has every edit refused, and the runtime logs a warning that names the
model. Auto mode checks an edit task's shell commands before they run, which can add
model calls and time. The checks use Claude Sonnet 5 where the account can call it, and
the task's model otherwise.

A Codex task runs without Codex's sandbox and can write anywhere its user can. A Codex
plan task is read-only by instruction only.

To refuse more, add `permissions.deny` rules to Claude Code's
[managed settings](https://code.claude.com/docs/en/managed-settings) where the task runs.

### Who can reach the runtime

By default the runtime is reachable from this machine only.

- It listens on `127.0.0.1`. `PRISM_HOST` widens that to the network — put an
  authenticating proxy in front of the port before you do.
- While it listens on `127.0.0.1`, a browser request that comes from another
  site is answered with 403.
- `PRISM_ALLOWED_ORIGINS` lets pages on the sites it lists use the runtime:
  its API, the chat connection and the Computer desktop. Those pages then act
  with the access of whoever signed in to the proxy, so set it only with an
  authenticating proxy in front. The runtime refuses it only while it listens
  on a loopback address; in Docker it listens on `0.0.0.0` whatever host port
  you publish, so the setting is accepted there.
- Cross-origin HTTP responses allow no credentials: a page on those sites reads
  only responses to requests it sent without cookies. A browser sends cookies
  when it opens a WebSocket whatever the page's origin, so the proxy in
  front must authenticate the chat and Computer connections from another site
  by token, not by its own session cookie. The runtime sets no cookies.
- In Docker the runtime listens on `0.0.0.0` — a published port needs that — so
  the container answers requests for any host name. `-p 127.0.0.1:3003:3003`
  keeps the port reachable from the host machine only; an authenticating proxy
  in front is what closes it to browsers on other sites.
- A proxy in front that rewrites the `Host` header must forward
  `X-Forwarded-Host` — most proxies do — or the Web UI's chat connection is
  answered with 403.
- A proxy forwarding to the default loopback listen must forward
  `X-Forwarded-Host` (Caddy's default; on nginx add
  `proxy_set_header X-Forwarded-Host $host`) or rewrite `Host` to a loopback
  name (`ngrok --host-header=rewrite`) — otherwise its requests, webhook
  deliveries included, are answered with 403.

[Webhooks](webhooks.md) arrive on their own port, `WEBHOOK_PORT`. The receiver
toggle, subscriptions and their sender credentials live in the database, managed
from the Web UI. Expose the webhook port to senders and keep `PORT` private;
each subscription can require a shared token or an HMAC signature from its
sender (see [Authentication](webhooks.md#authentication)).

## Tool risk gate

`TOOL_RISK_GATE_MODE` enables an optional policy check before tools execute,
using the active provider's classification model. It applies to every tool
call, apart from a few low-risk helpers that bypass it.

| Mode | Behavior |
|------|----------|
| `off` | No risk evaluation. This is the default and preserves existing behavior and latency. |
| `observe` | Evaluate calls and emit decision telemetry, but execute them regardless of the verdict. Evaluator failures also fail open. |
| `enforce` | Block calls classified as unsafe. If the evaluator errors or times out, the evaluated call is blocked rather than executed. A Codex task that the gate lets start runs without Codex's sandbox and can write anywhere its user can. |

### Writing your own policy

The check reads your **[Agent Guide](agent-identity.md)** and treats it as the
policy for the deployment. Two kinds of rule work:

- **Forbid more.** "Never touch the `prod-eu` cluster." The check now refuses a
  call it would otherwise have allowed.
- **Allow more.** "Force-pushing to any branch is fine here." The check now
  allows a call it would otherwise have refused.

A rule you write takes precedence on any point it covers, and the built-in rules
apply everywhere else. So a rule you write can switch off any part of the check,
including the refusal of broad deletion, secret exposure and permission changes.
Write it as narrowly as the work needs.

Treat the guide as part of your security configuration, because the check trusts
it. The agent holds a shell and the Management API needs no credential from
inside the container, so the agent can edit the guide even though it has no tool
for it. A rule that grants permission is therefore a rule the agent could grant
itself, which is why this is a guardrail rather than a security boundary — see
[Agent identity](agent-identity.md). `gate.policy_hash` in telemetry is a digest
of the guide in force: if it changes without you editing the guide, something
else changed it.

The guide is an operating manual, so most of it is advice on how to work rather
than a rule about what is allowed. The check reads it for the rules and takes
the rest as background.

A guide you have never edited is not used as policy, so a new agent runs on the
built-in rules alone. Edit any part of the guide and the whole document becomes
your policy, stock sentences included — so read it through before you switch from
`observe` to `enforce`. If it says "read-only by default" under `## Safety`,
remove that line: as policy it refuses the file edits and builds the agent needs
to work. Run `observe` first either way: it shows every rule that
would block work, before any work is blocked.

The guide is read as one block up to about 8,000 characters, cut on whole lines.
Past that the check reads the start and the end, so keep a rule out of the middle
of a very long guide. The runtime logs a warning when your guide is over the
limit. Your guide is sent with every checked tool call and is not cached, so a
long guide adds to the cost of each one.

### Rollout and failures

Invalid values resolve to `off` and produce a startup warning. A rejection is
returned to the agent as a failed tool call, so it can explain the refusal or
choose a safer approach. Tool arguments and user text are not included in
product telemetry.

The gate checks the `coding_agent` call that starts a coding task.
[What a coding task may do](#what-a-coding-task-may-do) describes what the task can
do after that.

This gate is defense in depth, not a sandbox: both the main agent and the risk
classifier are language models and can make mistakes. Keep OS permissions and
[Lens Sandbox](lens-sandbox.md) policy as the hard security boundary.

## Chat verbosity

The `verbose` setting controls how multi-step chat turns are delivered:

| Mode | Behavior |
|------|----------|
| **Concise** (default, `verbose=false`) | Only the final text step of a turn is delivered to the channel. Intermediate steps are still saved, but marked internal so they stay hidden from the conversation — both live and when the thread is reloaded. The tool calls they made are shown on the turn's final message, except those of the steps before a cancel or a message sent to steer the turn. The model's final message must be self-contained. |
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

## Locked-in mode

`lockedIn` stops the agent from reshaping itself. While the lock is on, the
agent's own tools may no longer rewrite six of the workspace markdown files, nor add
to or delete from its long-term memory:

| Frozen while locked | Still editable while locked |
|---------------------|-----------------------------|
| **Soul**, **User**, **Memory** (the curated summary), **Vision**, **Heartbeat** config, **Bootstrap**; **long-term memory** writes and deletes | **Behavioural settings** — heartbeat interval, timezone, `verbose`; the agent's **name** (`rename_self`); **long-term memory search**, so it still reads what it learned before the lock |

The **Agent Guide** is in neither column: no tool writes it, so the lock has
nothing to take away.

Your own editing keeps working while the lock is on — every document on the
Profile page, and restoring an earlier
[revision](agent-identity.md#version-history) of any of them. The lock withholds
the agent's own writers, and an edit or a restore there is you acting.

The lock works in two layers. The writing tools (`update_soul`, `update_memory`,
`update_user_profile`, `update_vision`, `update_heartbeat_config`,
`clear_bootstrap`, `memory_write`, `memory_delete`) are withheld from the tool
set, and every one of those writes is refused at the point it happens.
`memory_search` stays. Turning the lock on takes effect immediately. A locked
agent that is asked to change one of these files, or to remember something, says
what it would have done and points you at the setting.

**The agent cannot unlock itself.** Only you can, via:

- The **Profile** page toggle in the [Web UI](web-ui.md#profile)
- `PATCH /agents/locked-in` with `{ "lockedIn": true | false }`

Onboarding is paused while the lock is on: a locked agent with a non-empty
Bootstrap document does not run the first-run script, because it could not clear
it afterwards. The document is kept, so onboarding runs when you unlock the agent.

**The lock is a guardrail against drift, not a security boundary.** It has three
known holes:

- **The [shell](tools.md#shell) is never withheld.** Every agent has `shell_exec`,
  in every mode. The lock takes away the document tools, not the shell, and on
  the host a shell writes the documents straight into `/data/agent.db`. Such a
  write records no revision, so the document's
  [history](agent-identity.md#version-history) marks it as changed outside the
  app. When commands run in a container the database is not in the agent's
  storage at all, so that particular route is closed — see
  [where commands run](tools.md#where-commands-run).
- **The Management API takes no credential from inside the container.** Auth is
  terminated in front of the container, so a shell can `PATCH
  localhost:3003/agents/locked-in` and turn the lock off. "The agent cannot unlock
  itself" is a statement about its tools. The same shell can `PATCH
  localhost:3003/agents/documents/soulMd`, which is the endpoint your editor
  calls: the write records a revision that reads as your own edit, so the
  document's history tells you it changed but not that the agent changed it.
- **`POST /agents/import` is not gated.** It stages a whole replacement
  database — documents, memories, threads, and the lock's own setting — which the
  runtime swaps in on its next boot.

Lock an agent you want to hold still. Do not lock one you do not trust.

## Models

Which set applies depends on `LLM_PROVIDER`. Bedrock model IDs are Bedrock model
identifiers; **Azure model IDs are Foundry deployment names** (which default to
Claude model IDs when you deploy without renaming); **mantle model IDs are bare
Bedrock identifiers** — same names, no `us.`/`eu.`/`global.` prefix; **OpenAI
model IDs are plain OpenAI API model names**; **OpenRouter model IDs are
`vendor/model`**; **Anthropic model IDs are bare first-party names**
(`claude-opus-5`); **LiteLLM model IDs are the model names your proxy
defines**.

| Variable | Purpose | Default |
|----------|---------|---------|
| `BEDROCK_MODEL_ID` | **(Bedrock)** Main model (the agent's reasoning loop) | `global.anthropic.claude-opus-5-5` |
| `BEDROCK_CLASSIFICATION_MODEL_ID` | **(Bedrock)** Fast model for classification gates: the [heartbeat](heartbeat.md) and [scheduled-task](scheduled-tasks.md) DELIVER/SUPPRESS gate, and the optional [tool-risk gate](tools.md#risk-gate) | `global.anthropic.claude-haiku-5-5` |
| `BEDROCK_EMBEDDING_MODEL_ID` | **(Bedrock)** Embedding model for [searchable memory](memory.md) | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | **(Bedrock)** AWS region for Bedrock | `us-east-1` |
| `AZURE_MODEL_ID` | **(Azure)** Main model — a Claude chat deployment name | `claude-opus-5` |
| `AZURE_CLASSIFICATION_MODEL_ID` | **(Azure)** Fast Claude deployment for classification gates | `claude-haiku-5-5` |
| `AZURE_EMBEDDING_MODEL_ID` | **(Azure)** Azure OpenAI embedding deployment (a `text-embedding-3` model; truncated to 1024 dims to match the memory index). The deployment must exist on the resource, else memory embedding fails open (no vector). Set to `''` to skip embeddings entirely. | `text-embedding-3-small` |
| `AZURE_API_VERSION` | **(Azure)** Azure OpenAI API version (embeddings only) | SDK default (`preview`) |
| `BEDROCK_MANTLE_MODEL_ID` | **(Mantle)** Main model — a **bare** Bedrock ID | `anthropic.claude-opus-5` |
| `BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID` | **(Mantle)** Fast **bare** Bedrock ID for classification gates. Unversioned — mantle 404s the `…-20251001-v1:0` shape `bedrock-runtime` uses. | `anthropic.claude-haiku-4-5` |
| `BEDROCK_MANTLE_EMBEDDING_MODEL_ID` | **(Mantle)** Embedding model, served by Titan on `bedrock-runtime` — mantle has none of its own. Set to `''` to skip embeddings entirely. | `amazon.titan-embed-text-v2:0` |
| `AWS_REGION` | **(Mantle)** Region for both the mantle host and the Titan embedding leg | `us-east-1` |
| `OPENAI_MODEL_ID` | **(OpenAI)** Main model (the agent's reasoning loop) | `gpt-5.6-sol` |
| `OPENAI_CLASSIFICATION_MODEL_ID` | **(OpenAI)** Fast model for the heartbeat gate. The gates pin it to `reasoningEffort: 'none'` (the SDK name for the API's `reasoning.effort`) and send no `temperature` — GPT-5.x models reject or strip an explicit temperature, and reasoning tokens would eat the gates' tiny output budgets. | `gpt-5.6-luna` |
| `OPENAI_EMBEDDING_MODEL_ID` | **(OpenAI)** Embedding model (a `text-embedding-3` model; truncated to 1024 dims to match the memory index). Set to `''` to skip embeddings entirely. | `text-embedding-3-small` |
| `OPENROUTER_MODEL_ID` | **(OpenRouter)** Main model, as `vendor/model` — OpenRouter addresses every model that way, so a bare `gpt-5.6-sol` is not one it can route. The default mirrors the OpenAI tier so the provider's GPT-5.x parameter handling stays valid; point it at another vendor (`google/gemini-3-pro`, `deepseek/deepseek-v3.2`, `anthropic/claude-sonnet-5`) and those assumptions may not hold. | `openai/gpt-5.6-sol` |
| `OPENROUTER_CLASSIFICATION_MODEL_ID` | **(OpenRouter)** Fast `vendor/model` for the heartbeat gate, under the same parameter caveat as the OpenAI one. | `openai/gpt-5.6-luna` |
| `OPENROUTER_EMBEDDING_MODEL_ID` | **(OpenRouter)** Embedding model, as `vendor/model`. **Off by default**, unlike the other platforms: OpenRouter routes embedding models from several vendors whose native dimensionalities differ, and the memory index is fixed at 1024 dims — so there is no id that is right by default. Name one that can deliver 1024 (`openai/text-embedding-3-small` truncates to it) to switch memory embeddings on. | `''` (disabled) |
| `ANTHROPIC_MODEL_ID` | **(Anthropic)** Main model (the agent's reasoning loop) | `claude-opus-5` |
| `ANTHROPIC_CLASSIFICATION_MODEL_ID` | **(Anthropic)** Fast model for the heartbeat gate | `claude-haiku-5-5` |
| `LITELLM_MODEL_ID` | **(LiteLLM)** Main model, as your proxy names it | `claude-opus-5-5` |
| `LITELLM_CLASSIFICATION_MODEL_ID` | **(LiteLLM)** Fast model for classification gates, as your proxy names it. Name a Claude or other non-reasoning model: the gates allow a few output tokens, and a reasoning model can use them up before it answers. | `claude-haiku-5-5` |
| `CONTEXT_WINDOW_TOKENS` | Input-context window (tokens) to assume for the agent's model. Only needed when the catalog doesn't recognize it. Ignored unless a positive integer. | derived from the model ID |
| `MODELS_DEV_URL` | Refresh the model-window catalog from a registry once at startup. Unset means no outbound call, bundled catalog only. | — (disabled) |
| `COMPACTION_THRESHOLD_PERCENT` | Auto-[compact](compaction.md) a conversation when its context occupancy reaches this percent of the model's window. `0` disables auto-compaction; out-of-range values fall back to the default. | `90` |
| `COMPACTION_TAIL_MESSAGES` | How many of the newest messages stay out of compaction and remain in the context verbatim. `0` is allowed. | `6` |
| `DISABLE_UPDATER` | Set to `1` (or `true`) to turn off [automatic updates](installation.md#automatic-updates): the hourly check, the auto-install, and the `prism update` command. | — (updater on for native installs) |

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
`OPENAI_CLASSIFICATION_MODEL_ID` on OpenAI,
`OPENROUTER_CLASSIFICATION_MODEL_ID` on OpenRouter,
`ANTHROPIC_CLASSIFICATION_MODEL_ID` on Anthropic,
`LITELLM_CLASSIFICATION_MODEL_ID` on LiteLLM), independent of this.

### Memory embeddings

Which platform embeds [searchable memory](memory.md) is its own choice,
separate from `LLM_PROVIDER`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `EMBEDDING_PROVIDER` | Embedding platform: `bedrock` (Titan on `bedrock-runtime`), `azure-openai` (a `text-embedding-3` deployment on the Foundry resource), `openai` (the OpenAI API), `openrouter` (openrouter.ai's OpenAI-compatible `/embeddings`), or `none` (embeddings off — memory still works, vector search returns nothing). Unset — or any other value — derives the default from `LLM_PROVIDER`: `bedrock` and `bedrock-mantle` → `bedrock`, `azure` → `azure-openai`, `openai` → `openai`, `openrouter` → `openrouter` (whose embedding model defaults to off), `anthropic` → `openai` when `OPENAI_API_KEY` or `NEXUS_API_URL` is set (the gateway holds the key) and `none` otherwise (Anthropic serves no embedding models), `litellm` → `none`. | derived |

The embedding model itself still comes from the selected platform's
`*_EMBEDDING_MODEL_ID` variable above, with the same credentials. With
`NEXUS_API_URL` set, embeddings ride the embedding platform's own gateway
mount (`…/llm/bedrock/{region}` for `bedrock`, `…/llm/azure/openai/v1` for
`azure-openai`, `…/llm/openai/v1` for `openai`,
`…/llm/openrouter/openai/v1` for `openrouter`), independent of how chat
routes. So a Bedrock deployment can embed on OpenAI with
`EMBEDDING_PROVIDER=openai` plus an `OPENAI_API_KEY`, and any deployment can
turn embeddings off with `EMBEDDING_PROVIDER=none`. Setting
`AZURE_EMBEDDING_MODEL_ID` / `BEDROCK_MANTLE_EMBEDDING_MODEL_ID` /
`OPENAI_EMBEDDING_MODEL_ID` / `OPENROUTER_EMBEDDING_MODEL_ID` to `''` also
still disables embeddings;
`BEDROCK_EMBEDDING_MODEL_ID` has no `''` skip (empty falls back to Titan) —
use `EMBEDDING_PROVIDER=none` there.

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
| `NEXUS_API_URL` | Base URL of a Lens Agents instance, used for the LLM proxy and WebSocket authorization. When set, LLM calls route through that gateway (for any platform). It is **not** a fallback for `NEXUS_MCP_URL`. | — |

## Voice meetings

[Voice meetings](voice-meetings.md) let the agent join a Google Meet call and take
part by voice. The tools appear when a Realtime credential is configured and the
host has the browser/audio toolchain shipped in the container image.

Voice endpoint and credential resolution is independent of `LLM_PROVIDER`:

1. An explicit `OPENAI_REALTIME_URL` wins. It uses `OPENAI_REALTIME_API_KEY`,
   falling back to the existing `OPENAI_API_KEY`; managed credentials are not
   implicitly copied to an explicitly chosen host. A managed credential is
   accepted only for its matching discovered Realtime endpoint.
2. Otherwise, select a managed endpoint supporting the OpenAI Realtime protocol:
   primary provider first, then `LENS_MANAGED_INFERENCE_PROVIDERS` order. OpenAI
   and Azure are supported. Each uses its own namespaced base URL and API key;
   `OPENAI_REALTIME_API_KEY` does not replace a selected managed credential.
   In older environments without provider markers, prefer OpenAI, then Azure.
   A provider needs both its endpoint and credential to qualify.
3. With no eligible managed endpoint, use `OPENAI_REALTIME_API_KEY` for direct
   OpenAI. Standalone installs may also use `OPENAI_API_KEY` when no managed
   inference variables or custom `OPENAI_BASE_URL` are configured. Managed
   placeholders never become direct OpenAI credentials.

For example, Nexus can supply Bedrock for chat and Azure for voice:

```bash
LENS_MANAGED_INFERENCE_PROVIDER=bedrock
LENS_MANAGED_INFERENCE_PROVIDERS='["bedrock","openrouter","azure"]'
```

The provider list is a JSON array of provider IDs. In this example, Prism skips
Bedrock and OpenRouter for voice and selects Azure when its endpoint and matching
credential are present.

| Managed provider | Endpoint variable | Credential variable |
| --- | --- | --- |
| OpenAI | `LENS_INFERENCE_OPENAI_BASE_URL` | `LENS_INFERENCE_OPENAI_API_KEY` |
| Azure | `LENS_INFERENCE_AZURE_OPENAI_BASE_URL` | `LENS_INFERENCE_AZURE_OPENAI_API_KEY` |

Prism converts HTTPS to WSS and appends `/realtime`, preserving the path prefix.
`OPENAI_BASE_URL` remains a chat/embeddings setting. Bedrock can therefore serve
chat while Azure serves voice. OpenRouter and Bedrock Mantle's OpenAI-compatible
chat endpoints do not qualify for Realtime. OpenAI-compatible chat support
alone does not establish Realtime support.

Only direct voice requires egress to `api.openai.com`; managed voice uses the Lens
endpoint and its metering/budget controls. Remote sockets require WSS; plaintext
WS is accepted only on loopback. Selection happens at startup; restart existing
sandboxes after updating Prism or their discovery environment. A connection
failure is reported without trying another provider. Azure's
`OPENAI_REALTIME_MODEL` must name an actual Realtime deployment in the configured
resource; endpoint discovery does not verify deployment availability or quota.
The browser profile persists under the data directory, so meeting sign-in happens
once rather than per meeting.

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENAI_API_KEY` | Legacy direct-voice credential fallback. The same key drives chat when `LLM_PROVIDER=openai`, and memory embeddings by default when `LLM_PROVIDER=anthropic` — see [Provider selection](#provider-selection). | — (disabled) |
| `OPENAI_REALTIME_MODEL` | Realtime model for the agent's voice, in a meeting and in a [voice chat](voice-chat.md). Pinned to a snapshot so a new one cannot change behaviour under you; `gpt-realtime-mini` is materially cheaper. | `gpt-realtime-2.1` |
| `OPENAI_REALTIME_URL` | Explicit voice WebSocket endpoint; opts out of managed endpoint and credential discovery. | managed Realtime, else direct OpenAI |
| `OPENAI_REALTIME_API_KEY` | Credential for an explicit voice endpoint or direct fallback; does not replace a discovered managed credential. | selected managed key, else eligible direct key |
| `OPENAI_REALTIME_VOICE` | Voice name. | `marin` |
| `OPENAI_REALTIME_REASONING_EFFORT` | How hard the voice model thinks before it answers or picks a tool: `minimal`, `low`, `medium`, `high`, `xhigh`. The API's own default is `low`, which suits a voice agent that reads out an order status; the model in a call here holds the agent's real toolset — shell, kubectl, integrations, its own configuration — so this defaults higher. The cost is latency, and latency in a call is silence in a room, so lower it if the pause is more noticeable than the mistakes it prevents. Set empty to send no setting and take the API's default. | `high` |
| `GOOGLE_BOT_EMAIL` | Google account the agent signs into for meetings. **Effectively required**: Google auto-denies automated anonymous guests, so without this the agent reaches the lobby and is refused. Use a dedicated account. | — |
| `GOOGLE_BOT_PASSWORD` | Password for that account. **Must be the real password in plain text — a credential sentinel does not work here.** A sentinel is rewritten on the wire by the proxy, which only works for a secret sent as an HTTP header; this one is typed into Google's sign-in form by the browser, over TLS to Google, so the runtime has to hold the actual value. A deliberate trade-off: Google Meet has no bot or service-account API, so being in a call means driving a real browser signed into a real account. Treat it accordingly — a dedicated account with nothing else attached to it. Accounts with a phone/hardware challenge or enforced SSO cannot be signed in unattended. | — |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcriber for [dictation](dictation.md), and for reading a meeting back in the log. A meeting's transcript is never fed to the model, which hears audio, and no decision waits on it. **In a meeting it is only requested when `MEETING_TRANSCRIPT_LOGGING=full`**: it bills per minute of audio, and with logging off the words would be transcribed and then dropped. Billed at a small fraction of the Realtime audio rate for the same minute. The default accepts `keywords`, which is how the agent's own name and the other participants' names are given to it; a model without them still works, but names in the log are likelier to be wrong. | `gpt-live-transcribe` |
| `OPENAI_NOISE_REDUCTION` | How much noise reduction OpenAI applies to the meeting audio before deciding someone has spoken: `off`, `near_field`, or `far_field`. It is off by default, which sounds backwards for a room full of people — but the audio the agent receives is Google Meet's finished mix, already cleaned and levelled for every participant, so reducing it a second time mostly removes the quiet voices. With reduction on, an agent in a live call stopped responding to a person in the room for minutes at a time while still answering the other agent's much louder synthetic voice. Turn it on only if a particular room proves too noisy, and try `near_field` before `far_field`. | `off` |
| `MEETING_TRANSCRIPT_LOGGING` | Whether what is said in a call may appear in the runtime's log: `off` or `full`. `off` writes the verdict, the utterance it belongs to, how long the decision took and the *number* of people in the room — no words and no attendee names. `full` adds the roster and anything the model said beyond its one-word answer, plus a second line per utterance carrying the sentence itself. Off by default because a meeting is not an authenticated surface: the room did not agree to be written into a log that outlives the call, and a mangled name means the recorded words may not even be theirs. A setting of its own rather than a log level, so that turning up logging to chase an unrelated problem never starts recording the room by accident. Anything unrecognised (including empty) is treated as `off`. See [Voice meetings](voice-meetings.md#what-ends-up-in-the-log). | `off` |
| `MEETING_TIMEOUT_MINUTES` | Hard cap on one call, so a meeting nobody ended can't hold a browser and a metered socket open. Junk or non-positive falls back to the default. | `60` |
| `MEETING_ADMISSION_TIMEOUT_SECONDS` | How long to wait in the waiting room for a host to admit the agent, counted from when the join request goes in (reaching the lobby is budgeted separately). | `300` |

## Voice chat

[Voice chat](voice-chat.md) is a direct voice conversation between the agent and
one client. It needs the same resolved Realtime credential as voice meetings and uses the
same voice, model and reasoning settings from the table above. The agent has one
voice, so a voice chat and a Meet call exclude each other.

**There is nothing else to configure.** The audio travels on the connection the
client already uses for chat, so a voice chat works wherever chat works and needs
no relay and no browser. A voice meeting cannot run in the installed binary; this
can.

The web UI starts a call from the phone at the top right of its chat page, or
from **Talk** on its Computer page. Its chat composer's microphone records a
[voice message](dictation.md). The terminal UI
has no voice control, and any other client needs the runtime's voice frames —
see [Voice chat](voice-chat.md#starting-a-call).

## Observability

All optional; each is off until its variable is set. Langfuse traces every LLM
call (model, tokens, tool calls, latency), with prompts and completions included
— except the call that decides what to do with a threaded Slack message, which is
not traced at all, since its prompt is the channel's recent messages. Nothing said
in a meeting reaches it either: whether the agent was spoken to is put to the model
already in the call, over the audio, so no sentence is ever built into a prompt.
OpenTelemetry exports product telemetry to a collector; that surface carries no
prompts at all. Structured logs (Pino) are always on, and no error written to them
carries a request or response body.

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
the Lens Agents gateway, the model identifiers, on/off flags for Slack, that
gateway, the external MCP server and Langfuse, the host shape (packaged binary
or not, Node version, platform, architecture), and counts of cron tasks,
installed skills, installed plugins and subagents. Like
every other product event, it carries only identifiers, flags and counts — never
credentials, URLs, file paths, or message content.

## Installer variables

These affect the native [installer](installation.md), not the running agent:

| Variable | Purpose | Default |
|----------|---------|---------|
| `PRISM_HOME` | Install directory | `~/.prism` (`%USERPROFILE%\.prism`) |
| `PRISM_HTTP_URL` | Runtime URL the [`prism` TUI](cli-reference.md) connects to | `http://localhost:3003` |

## Public Web UI address

Computer help links and file links in Microsoft Teams use the public address supplied by Lens through `NEXUS_INGRESS_ORIGINS_WEB` (or the name of the exposed Web UI port). Set `PRISM_PUBLIC_URL` for standalone deployments or to override that address, including any path prefix.
