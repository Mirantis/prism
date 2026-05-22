/**
 * Global Teardown — runs once after all tests.
 *
 * Stops the OTEL Collector stack and disconnects Prisma.
 */

import { execSync } from 'child_process';
import path from 'path';
import { disconnect } from './support/db-helper';

async function globalTeardown() {
  await disconnect();

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
