import { chromium, defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import {
  AGENT_MESSAGES_TOKEN_ID,
  DEFAULT_AGENT_ID,
  E2E_DATA_DIR,
  E2E_WORKSPACE,
  TEST_USER,
  SLACK_COMPUTER_PUBLIC_URL,
} from './fixtures/test-data';
import { MOCK_REALTIME_PORT } from './support/mock-realtime-port';
import { WEBHOOK_PORT } from './support/webhook-port';
import { AGENT_MESSAGES_PORT } from './support/agent-messages-port';
import { noLlmProviderEnv } from './support/no-llm-provider-env';

// Load e2e environment variables (.env.e2e.local overrides for secrets)
config({ path: path.resolve(__dirname, '.env.e2e') });
config({ path: path.resolve(__dirname, '.env.e2e.local'), override: true });

// Match the ports baked into web/vite.config.ts so the SPA's built-in
// dev-server proxy ("/agents" + "/api/ws" → :3003) just works.
const RUNTIME_PORT = 3003;
const WEB_PORT = 5173;
/** An OpenAI key in the right form that the API refuses. */
const REFUSED_OPENAI_KEY = 'sk-e2e-refused-key';

// SQLite e2e DB lives next to the schema so Prisma's schema-relative path
// resolution (file:./e2e.db) lands on the same file from every cwd.
const REPO_ROOT = path.resolve(__dirname, '..');
const SQLITE_SCHEMA_DIR = path.join(REPO_ROOT, 'prisma', 'sqlite');
const E2E_DB_FILE = path.join(SQLITE_SCHEMA_DIR, 'e2e.db');
const E2E_DATABASE_URL = 'file:./e2e.db';

// Writable workspace for the agent's shell/share_file tools — the `/home/node`
// default isn't writable on CI, so outbound file-sharing (create-then-share)
// would fail without this. Created at config load so it exists before the
// runtime webServer boots.
fs.mkdirSync(E2E_WORKSPACE, { recursive: true });

// Persistent data dir for the runtime (skills live at <dir>/skills). Pointed at
// a temp dir via PRISM_DATA_DIR so we never touch the host's real ~/.prism, and
// seeded with a deterministic skill bundle BEFORE the runtime boots so it's in
// the catalog from the first request. The `echo-marker` skill instructs the
// agent to reply with a fixed sentinel, which the web-skills run scenario
// asserts end-to-end.
const E2E_ECHO_SKILL_DIR = path.join(E2E_DATA_DIR, 'skills', 'echo-marker');
fs.mkdirSync(E2E_ECHO_SKILL_DIR, { recursive: true });
fs.writeFileSync(
  path.join(E2E_ECHO_SKILL_DIR, 'SKILL.md'),
  '---\nname: echo-marker\ndescription: Reply with a fixed test marker.\n---\n\n' +
    'When this skill is invoked, reply with exactly the following text and nothing else:\n\n' +
    'SKILL_RAN_OK\n',
);

// An Agent Plugins bundle (agent-plugins.org), seeded the same way and for the
// same reason: the web-plugins scenarios assert that `/plugins` lists it and
// that the skill it contributes reaches the catalog labelled as plugin-provided.
const E2E_PLUGIN_DIR = path.join(E2E_DATA_DIR, 'plugins', 'demo');
fs.mkdirSync(path.join(E2E_PLUGIN_DIR, 'skills', 'plugin-marker'), { recursive: true });
fs.writeFileSync(
  path.join(E2E_PLUGIN_DIR, 'plugin.json'),
  JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'demo',
    version: '1.2.0',
    description: 'A demo plugin.',
  }),
);
fs.writeFileSync(
  path.join(E2E_PLUGIN_DIR, 'skills', 'plugin-marker', 'SKILL.md'),
  '---\nname: plugin-marker\ndescription: Reply with a fixed plugin marker.\n---\n\n' +
    'When this skill is invoked, reply with exactly the following text and nothing else:\n\n' +
    'PLUGIN_SKILL_RAN_OK\n',
);
// Its stdio MCP server, which the coding sub-agent scenario has the sub-agent call.
fs.copyFileSync(
  path.join(__dirname, 'fixtures', 'plugin-mcp-probe.mjs'),
  path.join(E2E_PLUGIN_DIR, 'server.mjs'),
);
fs.writeFileSync(
  path.join(E2E_PLUGIN_DIR, 'mcp.json'),
  JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { probe: { type: 'stdio', command: 'node', args: ['server.mjs'] } },
  }),
);

// Provision the SQLite e2e DB *at config load* so it exists before
// Playwright spawns the runtime webServer (the WebServerPlugin runs in
// the plugin-setup phase, which precedes globalSetup).
//
// Playwright also loads this config inside every worker process; we only
// want to provision once, in the main runner. Workers always have
// TEST_WORKER_INDEX set — its absence identifies the runner.
process.env.DATABASE_URL = E2E_DATABASE_URL;
// Pin AGENT_ID so the runtime's bootstrap path resolves to the same row
// db-helper.seed() upserts. Without this the runtime would generate a
// fresh UUID on first boot and the seeded agent would never match.
process.env.AGENT_ID = DEFAULT_AGENT_ID;
if (process.env.TEST_WORKER_INDEX === undefined) {
  // If a runtime from a previous local run is still listening on :3003,
  // Playwright's reuseExistingServer will adopt it — and that process has
  // an open FD on e2e.db. Unlinking the file here would orphan that FD:
  // the runtime keeps writing to the deleted inode while seed() writes
  // land on a fresh file the runtime never reads. Skip the wipe in that
  // case; globalSetup's resetAll() + seed() clears state via Prisma
  // through the same file. `prisma migrate deploy` is idempotent and
  // safe with open FDs, so it always runs.
  if (!isRuntimeAlive(RUNTIME_PORT)) {
    fs.rmSync(E2E_DB_FILE, { force: true });
    fs.rmSync(`${E2E_DB_FILE}-journal`, { force: true });
    fs.rmSync(`${E2E_DB_FILE}-wal`, { force: true });
    fs.rmSync(`${E2E_DB_FILE}-shm`, { force: true });
  }
  execSync('npx prisma migrate deploy --schema=prisma/sqlite/schema.prisma', {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: 'inherit',
  });
}

function isRuntimeAlive(port: number): boolean {
  try {
    execSync(`curl -sf -o /dev/null --max-time 1 http://localhost:${port}/health`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// A failing run has to be triageable from the run page alone. `html` needs the
// artifact downloaded and `list` needs the raw step log, so add:
//   - `github`, which turns each failure into a workflow annotation (test
//     title + message + file/line) visible on the run and in the job summary;
//   - `json`, a machine-readable copy of the same thing for anyone reading the
//     run through the API. It lands under the outputDir Playwright already
//     uploads as the `test-results` artifact.
// `github` is CI-only: locally it just prints ::error workflow commands next
// to the list reporter's own output. So is `blob`: CI runs the suite in shards,
// and the E2E workflow merges their blobs into one HTML report.
const reporters: ReporterDescription[] = [
  ['html', { open: 'never' }],
  ['list'],
  ['json', { outputFile: 'test-results/results.json' }],
];
if (process.env.CI) reporters.push(['github'], ['blob']);

const testDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.steps.ts'
});

export default defineConfig({
  testDir,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: reporters,

  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),

  use: {
    // The SPA formats numbers with the browser's locale, and steps compare against en-US figures.
    locale: 'en-US',
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // The voice scenario needs a microphone. The fake device is a synthetic tone
    // Chromium generates itself, so it needs no fixture and no host audio, and it
    // only ever appears to a `getUserMedia` caller — every other scenario is
    // unaffected. The grant is Playwright's own, per origin, and stays that way:
    // `--use-fake-ui-for-media-stream` grants the microphone whatever
    // `permissions` says, which would make the grant here decoration for the whole
    // suite and leave a "microphone blocked" scenario unwritable.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream'],
      // CI runs Playwright's own browser and must keep doing so. A host with no
      // Playwright download (its CDN is not always reachable) points this at a
      // system Chromium instead — a local export, never a path committed here.
      // It coexists with the project's `channel`.
      ...(process.env.E2E_CHROMIUM_PATH
        ? { executablePath: process.env.E2E_CHROMIUM_PATH }
        : {}),
    },
    permissions: ['microphone'],
  },

  projects: [
    {
      name: 'chromium',
      // `channel: 'chromium'` is the full browser. Playwright's headless default is
      // `chromium-headless-shell`, which implements no `getUserMedia` at all, so the
      // fake device above answers `NotSupportedError` there and a voice call cannot
      // start. `playwright install chromium` downloads both builds, so this needs
      // nothing from the workflow.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],

  webServer: [
    {
      // Run the runtime via tsx directly (not `npm run dev`) so it inherits
      // DATABASE_URL=file:./e2e.db from this config instead of the dev
      // script's hard-coded `file:./agent.db` prefix. The supervisor starts it
      // again after a SIGKILL, which the restart scenario sends.
      command: 'npx tsx e2e/support/runtime-supervisor.ts',
      cwd: REPO_ROOT,
      // `url` rather than `port`: a bare port is satisfied by anything holding
      // the socket, and this runtime binds *after* `initialize()` — Slack
      // `auth.test`, MCP, cron. Probing `/health` means "the runtime is serving",
      // which is what the first scenario actually needs.
      //
      // 180s rather than 60s because that initialize step is the slow, network-
      // dependent part (Slack over the public internet on a shared runner), and
      // when it overran the old budget Playwright killed the runtime and failed
      // the whole suite at ~1.1 min with `Timed out waiting 60000ms from config`
      // — a message that names no cause. tsx also has to compile the runtime's
      // TypeScript on the way in.
      url: `http://localhost:${RUNTIME_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      // Playwright's webServer.stdout defaults to 'ignore'; opt in so the
      // runtime's pino logs (which go to stdout) show up with [WebServer]
      // prefix in the test output, alongside the stderr stream that's
      // already piped by default.
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(RUNTIME_PORT),
        WEBHOOK_PORT: String(WEBHOOK_PORT),
        AGENT_MESSAGES_PORT: String(AGENT_MESSAGES_PORT),
        PRISM_PUBLIC_URL: process.env.SLACK_E2E_BOT_TOKEN ? SLACK_COMPUTER_PUBLIC_URL : '',
        NEXUS_INGRESS_ORIGINS_WEB: process.env.SLACK_E2E_BOT_TOKEN
          ? `http://alias.localhost:${WEB_PORT}`
          : `http://localhost:${WEB_PORT},http://alias.localhost:${WEB_PORT}`,
        LENS_SANDBOX_INGRESS_PORTS: `web=${RUNTIME_PORT}`,
        DATABASE_URL: E2E_DATABASE_URL,
        AGENT_ID: DEFAULT_AGENT_ID,
        // The token id the agent message steps send as the ingress would.
        AGENT_MESSAGES_TOKEN_ID,
        // Writable workspace for the agent's shell/share_file tools (see above).
        SHELL_WORKSPACE_ROOT: E2E_WORKSPACE,
        // Persistent data dir → skills live at <dir>/skills (seeded above).
        PRISM_DATA_DIR: E2E_DATA_DIR,
        // Pinned, not derived: CI runners have a container engine, so the
        // suite would otherwise run the agent's commands in a container on CI
        // and on the host locally, which is two different tests under one name.
        // The scenario that does want a container sets this itself.
        EXECUTION_ENVIRONMENT: process.env.EXECUTION_ENVIRONMENT ?? 'local',
        // Pinned for the same reason: a `THREAD_MODE` in the repo-root .env would
        // otherwise run the whole suite with one conversation. The @single-thread
        // job sets it.
        THREAD_MODE: process.env.THREAD_MODE || 'multi',
        // Pinned for the same reason, at the default. The @tool-search job sets 0,
        // which defers the demo plugin's MCP tool.
        TOOL_SEARCH: 'auto',
        TOOL_SEARCH_THRESHOLD_PERCENT: process.env.TOOL_SEARCH_THRESHOLD_PERCENT || '2',
        // The exec image tag the runtime asks for. The container-mode job sets
        // it to the image it built; every other run leaves it unset.
        ...(process.env.SERVICE_VERSION ? { SERVICE_VERSION: process.env.SERVICE_VERSION } : {}),
        // Heartbeat-driven broadcasts publish under config.ownerUserId, and
        // the slack adapter delivers via SlackMapping rows scoped by
        // lensUserId. db-helper.seed() uses TEST_USER.id, so the SPA's
        // verification flow stamps that same id into the mapping — pin
        // ownerUserId here so both sides agree.
        OWNER_USER_ID: TEST_USER.id,
        BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID ?? '',
        AWS_REGION: process.env.AWS_REGION || 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
        ...(process.env.AWS_SESSION_TOKEN
          ? { AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN }
          : {}),
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
        SLACK_BOT_TOKEN: process.env.SLACK_E2E_BOT_TOKEN || '',
        SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN || '',
        SLACK_EXPECTED_APP_ID: process.env.SLACK_E2E_EXPECTED_APP_ID || '',
        SLACK_SKIP_BOT_ID_CHECK: 'true',
        // The coding sub-agent scenario spawns the `claude` CLI, which runs on
        // the same Bedrock token as the runtime rather than on an Anthropic login.
        CLAUDE_CODE_USE_BEDROCK: '1',
        // Teams adapter credentials for the @teams suite (empty = adapter
        // idle, suite self-skips). The Azure Bot's messaging endpoint must
        // separately point at this runtime's bot port for live runs, through
        // a tunnel (see e2e/README.md).
        TEAMS_APP_ID: process.env.TEAMS_E2E_APP_ID || '',
        TEAMS_APP_PASSWORD: process.env.TEAMS_E2E_APP_PASSWORD || '',
        TEAMS_APP_TENANT_ID: process.env.TEAMS_E2E_TENANT_ID || '',
        // The context-window scenarios compute their expected percentage from the
        // bundled catalog, so a fresher remote window would make them flaky by design.
        MODELS_DEV_URL: 'off',
        // A ChatGPT subscription run holds OpenAI keys the API refuses, so a Codex
        // task can succeed only on the saved login (`@codex-subscription`).
        ...(process.env.CODEX_SUBSCRIPTION === 'true'
          ? { OPENAI_API_KEY: REFUSED_OPENAI_KEY, CODEX_API_KEY: REFUSED_OPENAI_KEY }
          : { OPENAI_API_KEY: process.env.OPENAI_API_KEY || '' }),
        // The browser the agent's computer opens. The runtime looks for one in the
        // places an image installs it, and this suite runs the runtime on the host,
        // where there may be none — so it is handed the Chromium this suite already
        // installs rather than the run depending on what the host happens to have.
        PRISM_CHROMIUM_PATH: process.env.E2E_CHROMIUM_PATH || chromium.executablePath(),
        // Last, so it replaces the credentials above: the @no-llm-provider run
        // starts the runtime with none.
        ...(process.env.E2E_NO_LLM_PROVIDER === 'true'
          ? noLlmProviderEnv(path.join(E2E_DATA_DIR, 'no-aws'))
          : {}),
      },
    },
    {
      command: 'npm run dev',
      cwd: path.resolve(__dirname, '../web'),
      port: WEB_PORT,
      // Vite's cold start is the other thing racing a loaded runner. Same
      // reasoning as the runtime above; `port` is fine here because a listening
      // Vite is a serving Vite.
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The voice model the runtime talks to. Playwright owns its lifecycle, and
      // `stdout: 'pipe'` puts its log beside the runtime's — which is where a
      // failing voice scenario is read from.
      command: 'npx tsx support/mock-realtime-server.ts',
      cwd: __dirname,
      url: `http://127.0.0.1:${MOCK_REALTIME_PORT}/health`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { MOCK_REALTIME_PORT: String(MOCK_REALTIME_PORT) },
    },
  ],
});
