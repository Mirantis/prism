# Prism Agent — End-to-End Tests

Playwright BDD tests for the agent runtime + web SPA (and related integrations like Slack/telemetry).

## Prerequisites

- Node.js 24+
- Docker (for the OTEL Collector + MinIO test stack)
- Playwright browsers installed (`npx playwright install chromium`)

Coding delegation scenarios need the CLIs on `PATH`: `npm install -g @anthropic-ai/claude-code @openai/codex`.

## Environment Variables

The tests load `.env.e2e` for service configuration (database, auth, etc.).

AWS/Bedrock credentials must be set in your shell **before** running the tests:

```bash
export AWS_BEARER_TOKEN_BEDROCK=
export AWS_REGION=
export BEDROCK_MODEL_ID=
export BEDROCK_CLASSIFICATION_MODEL_ID=
export AWS_ACCESS_KEY_ID=
export AWS_SECRET_ACCESS_KEY=
export AWS_SESSION_TOKEN=
```

Coding-agent selection scenarios use an API key, a saved Codex login, or Bedrock credentials with access to OpenAI models.
To test a saved login, start with a stopped test runtime and run
`CODEX_HOME=/path/to/codex-home OPENAI_API_KEY= CODEX_API_KEY= npm run test --workspace=prism-agent-e2e -- --grep @codex-login`.
The Codex home must contain a valid, writable `auth.json` from `codex login`.
To test a Claude subscription, sign a Claude home in with
`CLAUDE_CONFIG_DIR=/path/to/claude-home claude auth login`, then run
`CLAUDE_CONFIG_DIR=/path/to/claude-home CLAUDE_CODE_SUBSCRIPTION=true npm run test --workspace=prism-agent-e2e -- --grep @claude-subscription`.

### The voice chat scenario

It needs no OpenAI account: the runtime discovers a synthetic managed Azure
endpoint served by `support/mock-realtime-server.ts`. That server requires the
Azure route and matching decoy credential, and the microphone is Chromium's own synthetic
capture device.

On a host with no Playwright-managed browser, name a system Chromium instead:

```bash
E2E_CHROMIUM_PATH=/usr/bin/chromium npm run test --workspace=prism-agent-e2e
```

Never commit that path — CI has its own browser and must keep using it.

## Running Tests

From the repo root:

```bash
# Headless (default) — runs in the background with no browser window
npm run test --workspace=prism-agent-e2e

# Headed — opens a visible browser window
npm run test:headed --workspace=prism-agent-e2e

# Debug — opens Playwright Inspector for step-by-step execution
npm run test:debug --workspace=prism-agent-e2e
```

### Viewing Reports

After a test run, open the HTML report:

```bash
npm run test:report
```

### Shards

CI splits the web suite into four shards by recorded duration. To run CI's second shard:

```bash
npm run test:e2e:web --workspace=prism-agent-e2e -- --shard=2/4
```

The durations are in `support/web-shard-timings.json`. To refresh them, download the `playwright-report` artifact of a green E2E run and run `npx tsx support/update-web-shard-timings.ts results.json` from `e2e/`.

### LLM cache

Both suites answer a chat or classification call from `e2e/llm-cache/` when an earlier run made the same call, and record every other one there. CI keeps the directory between green runs. Set `AGENTIC_EVALS_CACHE_MODE=off` to send every call to the model, and delete the directory to start over. A recording holds the model's output and its tool-call arguments, so keep secrets out of test inputs.

A call matches a recording only when everything the model receives is the same, apart from uuids, the date line in the system prompt, times as `toISOString()` and `toLocaleString()` print them, and paths under the temp directory. Give every other test input a fixed value: a fixed port, and a uuid where a name must be unique.

## TUI (CLI) tests

The `prism-cli` end-to-end tests live in `tui/` and are **separate** from the
Playwright web suite. They drive the CLI under a real `node-pty` PTY against a
live agent-runtime, and are written in Gherkin via
[`@amiceli/vitest-cucumber`](https://www.npmjs.com/package/@amiceli/vitest-cucumber)
(which runs on vitest, so the `node-pty` harness and config are preserved):

- `tui/features/*.feature` — the Gherkin scenarios.
- `tui/tests/*.test.ts` — step bindings + the runtime/PTY lifecycle, wired
  through the `BeforeAllScenarios` / `BeforeEachScenario` / `AfterEachScenario`
  / `AfterAllScenarios` hooks (`setupRuntime` → `startPrism` → `stop` →
  `cleanup`). Steps reused across scenarios are registered once via
  `defineSteps`.

```bash
npm run test:e2e:tui --workspace=prism-agent-e2e
```

These need Node 24+ and (for the chat/tool-call/file scenarios) AWS/Bedrock
credentials in the shell. Boot, slash-command, panel, and management-command
scenarios don't call the LLM.

## Slack E2E Setup

The `@slack` tagged tests require a real Slack workspace and app. Without credentials, these tests are skipped automatically.

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "Lens E2E Test") and select your workspace

### 2. Configure Permissions

**OAuth & Permissions** → add these scopes:

Bot Token Scopes:

- `channels:history`, `channels:join`, `channels:read`
- `chat:write`, `reactions:add`, `users:read`
- `files:write`, `files:read`

User Token Scopes:

- `channels:manage`, `channels:write.invites`
- `chat:write`, `channels:history`
- `files:write`, `files:read`

The four `files:*` entries were missing until 2026-08-25, so the file-sharing
scenarios could not pass on an app built from this list — they had been skipped
since the day they were written, and nothing reported the gap. Both tokens need
both: each side of those scenarios uploads a file and reads the other's back.
Without them the upload fails `missing_scope`.

Reinstall the app after changing scopes — an already-issued token keeps the
permissions it was granted.

### 3. Enable Socket Mode

**Socket Mode** → Enable → create an app-level token (e.g. "e2e") with `connections:write` scope → copy the `xapp-...` token.

### 4. Subscribe to Events

**Event Subscriptions** → Enable → add bot event: `message.channels`

### 5. Install and Collect Tokens

**Install App** to workspace, then collect:

| Value | Where to find it |
|---|---|
| `SLACK_CLIENT_ID` | Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | Basic Information → App Credentials |
| `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens (`xapp-...`) |
| `SLACK_E2E_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-...`) |
| `SLACK_E2E_USER_TOKEN` | OAuth & Permissions → User OAuth Token (`xoxp-...`) |
| `SLACK_E2E_TEAM_ID` | Visible in workspace URL: `app.slack.com/client/T.../...` |
| `SLACK_E2E_TEAM_NAME` | Your workspace display name |
| `SLACK_E2E_BOT_USER_ID` | Run: `curl -s -H "Authorization: Bearer xoxb-..." https://slack.com/api/auth.test` → `user_id` field |
| `SLACK_E2E_EXPECTED_APP_ID` | Basic Information → App ID (`A...`). Forwarded to the runtime as `SLACK_EXPECTED_APP_ID`, which checks the bot token's own `app_id` against it on boot — a value from a different app fails startup rather than a test. Required by the `@slack` skip guard, so all six of those scenarios skip while it is unset. |

### 6. Configure Credentials

**Locally:** Copy `.env.e2e.local.example` to `.env.e2e.local` and fill in the values.

**CI (GitHub Actions):** Add each value as a repository secret (prefixed with `SLACK_E2E_` — see `.github/workflows/e2e.yml`).

## Teams E2E Setup

The `@teams` tagged tests require a dedicated Microsoft 365 test tenant and run
**locally only**. CI does not run them: Bot Framework cannot reach the CI
runner, and the delegated Graph token (step 4) expires in about an hour, so a
static CI secret cannot keep the suite green. Without the `TEAMS_E2E_*` values
the suite skips automatically.

1. Register the bot per **[docs/teams.md](../docs/teams.md)** (Entra app +
   client secret, Single Tenant Azure Bot, Teams channel enabled, app package
   with the `ChannelMessage.Read.Group` permission sideloaded into the test
   tenant).
2. Point the Azure Bot's **messaging endpoint** at the e2e runtime — Bot
   Framework cannot reach localhost. Tunnel the runtime's **bot port**
   (`TEAMS_PORT`, default `3979`), which serves only the messaging endpoint,
   and never the runtime port itself: the e2e runtime's management routes are
   unauthenticated. See
   **[docs/teams.md](../docs/teams.md#the-public-messaging-endpoint)**, then set
   the endpoint to `https://<tunnel>/agents/teams/messages`.
3. Provision the targets the suite posts into: a **team + channel** with the
   bot app added, and a **personal chat** between the human test user and the
   bot (send it any message once to create the chat, then read the chat id via
   Graph `GET /me/chats`).
4. Get a **delegated Graph token** for the human test user with
   `ChannelMessage.Send`, `ChannelMessage.Read.All`, and `Chat.ReadWrite` —
   this is what makes the suite's messages come from a real person, not the
   bot.
5. Fill in the `TEAMS_E2E_*` values in `.env.e2e.local` (see
   `.env.e2e.local.example`) and run the suite locally. Do not add them as CI
   secrets — the token is short-lived, so the CI job deliberately does not set
   them.

## How It Works

1. Playwright config provisions `prisma/sqlite/e2e.db` and runs Prisma migrations (at config load).
2. Playwright starts three servers: agent-runtime (:3003 via tsx), the Vite web app (:5173), and the mock voice model (:3103, `support/mock-realtime-server.ts`).
3. `global-setup.ts` starts the OTEL Collector + MinIO stack and seeds the SQLite DB.
4. `global-teardown.ts` stops the OTEL stack and disconnects Prisma.

Tests run sequentially (`workers: 1`) because they share a single database and agent state.
