# Lens Agents — End-to-End Tests

Playwright BDD tests for the Lens Agents subsystem (backend, agent-runtime, frontend).

## Prerequisites

- Node.js 24+
- PostgreSQL running locally with a `lens_platform_e2e` database
- Playwright browsers installed (`npx playwright install chromium`)

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

## Running Tests

From the `packages/lens-agents/e2e` directory:

```bash
# Headless (default) — runs in the background with no browser window
npm test

# Headed — opens a visible browser window
npm run test:headed

# Debug — opens Playwright Inspector for step-by-step execution
npm run test:debug
```

### Viewing Reports

After a test run, open the HTML report:

```bash
npm run test:report
```

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

User Token Scopes:

- `channels:manage`, `channels:write.invites`
- `chat:write`, `channels:history`

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
| `SLACK_E2E_EXPECTED_APP_ID` | Basic Information → App ID (`A...`). Forwarded to the backend as `SLACK_EXPECTED_APP_ID` so the configure-Slack flow accepts tokens from this app. |

### 6. Configure Credentials

**Locally:** Copy `.env.e2e.local.example` to `.env.e2e.local` and fill in the values.

**CI (GitHub Actions):** Add each value as a repository secret (prefixed with `SLACK_E2E_` — see `.github/workflows/e2e.yml`).

## How It Works

1. **Global setup** starts a mock JWKS server, runs Prisma migrations, seeds the database, and generates a NextAuth session cookie (`storageState.json`).
2. Playwright launches three dev servers (backend :3001, agent-runtime :3003, frontend :3000).
3. Feature files in `features/` are executed using step definitions from `steps/`.
4. **Global teardown** stops the mock JWKS server.

Tests run sequentially (`workers: 1`) because they share a single database and agent state.
