import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import { DEFAULT_AGENT_ID, TEST_USER } from './fixtures/test-data';

// Load e2e environment variables (.env.e2e.local overrides for secrets)
config({ path: path.resolve(__dirname, '.env.e2e') });
config({ path: path.resolve(__dirname, '.env.e2e.local'), override: true });

// Match the ports baked into web/vite.config.ts so the SPA's built-in
// dev-server proxy ("/agents" + "/api/ws" → :3003) just works.
const RUNTIME_PORT = 3003;
const WEB_PORT = 5173;

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
const E2E_WORKSPACE = path.join(os.tmpdir(), 'prism-e2e-workspace');
fs.mkdirSync(E2E_WORKSPACE, { recursive: true });

// Persistent data dir for the runtime (skills live at <dir>/skills). Pointed at
// a temp dir via PRISM_DATA_DIR so we never touch the host's real ~/.prism, and
// seeded with a deterministic skill bundle BEFORE the runtime boots so it's in
// the catalog from the first request. The `echo-marker` skill instructs the
// agent to reply with a fixed sentinel, which the web-skills run scenario
// asserts end-to-end.
const E2E_DATA_DIR = path.join(os.tmpdir(), 'prism-e2e-data');
const E2E_ECHO_SKILL_DIR = path.join(E2E_DATA_DIR, 'skills', 'echo-marker');
fs.mkdirSync(E2E_ECHO_SKILL_DIR, { recursive: true });
fs.writeFileSync(
  path.join(E2E_ECHO_SKILL_DIR, 'SKILL.md'),
  '---\nname: echo-marker\ndescription: Reply with a fixed test marker.\n---\n\n' +
    'When this skill is invoked, reply with exactly the following text and nothing else:\n\n' +
    'SKILL_RAN_OK\n',
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
  reporter: [['html', { open: 'never' }], ['list']],

  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      // Run the runtime via tsx directly (not `npm run dev`) so it inherits
      // DATABASE_URL=file:./e2e.db from this config instead of the dev
      // script's hard-coded `file:./agent.db` prefix.
      command: 'npx tsx src/index.ts',
      cwd: REPO_ROOT,
      port: RUNTIME_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      // Playwright's webServer.stdout defaults to 'ignore'; opt in so the
      // runtime's pino logs (which go to stdout) show up with [WebServer]
      // prefix in the test output, alongside the stderr stream that's
      // already piped by default.
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(RUNTIME_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        AGENT_ID: DEFAULT_AGENT_ID,
        // Writable workspace for the agent's shell/share_file tools (see above).
        SHELL_WORKSPACE_ROOT: E2E_WORKSPACE,
        // Persistent data dir → skills live at <dir>/skills (seeded above).
        PRISM_DATA_DIR: E2E_DATA_DIR,
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
      },
    },
    {
      command: 'npm run dev',
      cwd: path.resolve(__dirname, '../web'),
      port: WEB_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
