/**
 * Global Setup — runs once after webServers are up, before tests.
 *
 * 1. Load .env.e2e (kept for global-setup-only consumers; webServers
 *    already have the env they need via playwright.config.ts)
 * 2. Start OTEL Collector + MinIO (fake S3) for telemetry e2e tests
 * 3. Reset + seed the database
 *
 * Note: SQLite e2e.db creation + `prisma migrate deploy` happens in
 * playwright.config.ts at module load, because Playwright's
 * WebServerPlugin runs before globalSetup — the runtime would crash on
 * an unmigrated DB if we provisioned here.
 */

import { config } from 'dotenv';
import path from 'path';
import { execSync } from 'child_process';
import { resetAll, seed, disconnect } from './support/db-helper';

/**
 * Container state + recent logs for the telemetry stack, for embedding in a
 * thrown error. Never throws itself: it runs on the failure path, where losing
 * the real error to a diagnostic's own failure would be the worst outcome.
 */
function describeCompose(): string {
  const run = (args: string) => {
    try {
      return execSync(`docker compose -f docker-compose.otelcol.yml ${args}`, {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      return `<\`${args}\` failed: ${error instanceof Error ? error.message : String(error)}>`;
    }
  };
  return (
    `--- docker compose ps ---\n${run('ps --all')}\n` +
    `--- docker compose logs (last 50 lines/container) ---\n${run('logs --tail 50 --no-color')}`
  );
}

async function globalSetup() {
  // 1. Load env (.env.e2e.local overrides for secrets)
  config({ path: path.resolve(__dirname, '.env.e2e') });
  config({ path: path.resolve(__dirname, '.env.e2e.local'), override: true });

  // 2. Start OTEL Collector + MinIO (fake S3) for telemetry e2e tests
  console.log('[e2e] Starting OTEL Collector + MinIO...');
  try {
    execSync('docker compose -f docker-compose.otelcol.yml up -d --build', {
      cwd: __dirname,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } catch (error) {
    // `stdio: 'pipe'` means the compose output is on the error object, not the
    // console — without this it is lost, and the run fails with a bare non-zero
    // exit from a command whose whole job is to explain itself.
    throw new Error(
      `docker compose up failed.\n${describeCompose()}\n--- original error ---\n` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  // The collector starts after MinIO creates the telemetry bucket.
  const otelReady = async () => {
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        const res = await fetch('http://localhost:4318/v1/logs', { method: 'POST', body: '{}' });
        // Any HTTP response (200, 400, 415) means the server is up
        if (res.status > 0) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Which container never came up, and why, is the whole diagnosis — and it is
    // gone by the time anyone reads the log, because global-teardown runs
    // `compose down`.
    throw new Error(`OTEL Collector did not become ready within 90s.\n${describeCompose()}`);
  };
  await otelReady();
  console.log('[e2e] OTEL Collector ready');

  // 3. Reset + seed
  await resetAll();
  const agentId = await seed();
  console.log(`[e2e] Database seeded (agentId: ${agentId})`);

  await disconnect();
}

export default globalSetup;
