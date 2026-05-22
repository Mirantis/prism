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

async function globalSetup() {
  // 1. Load env (.env.e2e.local overrides for secrets)
  config({ path: path.resolve(__dirname, '.env.e2e') });
  config({ path: path.resolve(__dirname, '.env.e2e.local'), override: true });

  // 2. Start OTEL Collector + MinIO (fake S3) for telemetry e2e tests
  console.log('[e2e] Starting OTEL Collector + MinIO...');
  execSync('docker compose -f docker-compose.otelcol.yml up -d', {
    cwd: __dirname,
    stdio: 'pipe',
    timeout: 120_000,
  });
  // Wait for otelcol to accept OTLP requests
  const otelReady = async () => {
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        const res = await fetch('http://localhost:4318/v1/logs', { method: 'POST', body: '{}' });
        // Any HTTP response (200, 400, 415) means the server is up
        if (res.status > 0) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('OTEL Collector did not become ready within 30s');
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
