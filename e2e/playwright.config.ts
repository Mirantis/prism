import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import { DEFAULT_AGENT_ID } from './fixtures/test-data';

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
  fs.rmSync(E2E_DB_FILE, { force: true });
  fs.rmSync(`${E2E_DB_FILE}-journal`, { force: true });
  execSync('npx prisma migrate deploy --schema=prisma/sqlite/schema.prisma', {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: 'inherit',
  });
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
  forbidOnly: !!process.env.CI,
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
      env: {
        PORT: String(RUNTIME_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        AGENT_ID: DEFAULT_AGENT_ID,
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
