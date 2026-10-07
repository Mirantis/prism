/**
 * Global Teardown — runs once after all tests.
 *
 * Stops the OTEL Collector stack and disconnects Prisma.
 */

import { execSync } from 'child_process';
import path from 'path';
import { disconnect } from './support/db-helper';
import { reportLlmCacheStats } from './support/llm-cache-files';

async function globalTeardown() {
  await disconnect();
  reportLlmCacheStats('web');

  // Stop OTEL Collector + MinIO
  try {
    execSync('docker compose -f docker-compose.otelcol.yml down -v', {
      cwd: path.resolve(__dirname),
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    // Best-effort cleanup
  }
}

export default globalTeardown;
