/**
 * Per-file setup utilities for the TUI e2e suite.
 *
 * Each file calls `setupRuntime()` once in `beforeAll` to provision a temp
 * SQLite DB + temp log file, allocate a free port, push the Prisma schema,
 * boot `agent-runtime` against it, and return the env block the harness
 * hands to `node-pty` when spawning `prism-cli`. Between tests, the file
 * calls `resetThread(dbPath)` to wipe conversation state without re-booting
 * the runtime.
 *
 * Real Bedrock is used (matching the Playwright BDD suite). AWS creds flow
 * through from `process.env` — same pattern `e2e/.env.e2e` documents.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { startRuntime, type RuntimeHandle } from './harness';

const AGENT_RUNTIME_DIR = path.resolve(import.meta.dirname, '../..');
const SQLITE_SCHEMA = path.join(AGENT_RUNTIME_DIR, 'prisma/sqlite/schema.prisma');

export interface RuntimeTestEnv {
  /** Temp directory holding the SQLite DB. */
  tempDir: string;
  /** Absolute path to the SQLite DB file. */
  dbPath: string;
  /** Port the runtime is listening on. */
  port: number;
  /** Env block to pass to `startPrism({ env })`. */
  prismEnv: NodeJS.ProcessEnv;
  /** Handle to the running agent-runtime process — pass to startPrism for log tailing in error messages. */
  runtime: RuntimeHandle;
  /** Stop the runtime and remove the temp dir. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

export interface SetupOptions {
  /** Extra env to layer onto the prism env (useful for per-test overrides). */
  prismEnvOverrides?: Record<string, string | undefined>;
}

export async function setupRuntime(opts: SetupOptions = {}): Promise<RuntimeTestEnv> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-'));
  const dbPath = path.join(tempDir, 'agent.db');
  const port = await findFreePort();

  // Apply the SQLite schema to the fresh DB. `db push` is the right tool for
  // a one-shot dev/test DB — no migration history needed.
  execSync(
    `npx prisma db push --schema=${SQLITE_SCHEMA} --skip-generate --accept-data-loss`,
    {
      cwd: AGENT_RUNTIME_DIR,
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: 'pipe',
    },
  );

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}`,
    PORT: String(port),
    // Only pass BEDROCK_MODEL_ID through when the surrounding env actually
    // sets it; otherwise let the runtime's own default (src/config.ts) win.
    // The Playwright e2e suite does the same, and the CI IAM role is
    // provisioned around that default.
    ...(process.env.BEDROCK_MODEL_ID
      ? { BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID }
      : {}),
    NODE_ENV: 'development',
    // AWS creds + region inherited from the surrounding shell / CI.
    // NEXUS_API_URL deliberately not set — createProvider falls back to
    // direct Bedrock when it's unset, which is what the TUI suite wants.
  };

  let runtime: RuntimeHandle;
  try {
    runtime = startRuntime({ env: runtimeEnv });
    await runtime.waitForReady(60_000);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // wsUrl is derived from httpUrl by the CLI; no PRISM_WS_URL.
    PRISM_HTTP_URL: `http://127.0.0.1:${port}`,
    ...(runtimeEnv.BEDROCK_MODEL_ID
      ? { BEDROCK_MODEL_ID: runtimeEnv.BEDROCK_MODEL_ID }
      : {}),
    NODE_ENV: 'development',
  };
  const prismEnv = { ...baseEnv, ...(opts.prismEnvOverrides ?? {}) };

  let cleaned = false;
  return {
    tempDir,
    dbPath,
    port,
    prismEnv,
    runtime,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await runtime.kill();
      } catch {
        // best-effort
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Wipe conversation rows so subsequent tests in the same file see a clean
 * thread without rebooting the runtime. The thread row itself is preserved
 * so `getOrCreateActiveThread()` keeps the same id.
 */
export function resetThread(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('DELETE FROM conversation_messages;');
  } finally {
    db.close();
  }
}

/**
 * Minimal JSON HTTP client for the runtime's management API. Specs use it to
 * seed state (e.g. a cron task) and to assert side effects authoritatively —
 * the on-screen frame shows the SYSTEM reply; this confirms the runtime row.
 * Throws on non-2xx so a broken endpoint fails the test loudly.
 */
export async function runtimeRequest<T = unknown>(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`runtimeRequest ${method} ${reqPath} → ${res.status}: ${detail}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Delete every cron task via the REST API — which also unschedules it in the
 * runtime's in-memory scheduler (a raw SQLite wipe would leave stale jobs).
 * Call in `beforeEach` so panel specs are order-independent.
 */
export async function clearCronTasks(port: number): Promise<void> {
  const tasks = await runtimeRequest<Array<{ id: string }>>(port, 'GET', '/agents/cron-tasks');
  for (const task of tasks) {
    await runtimeRequest(port, 'DELETE', `/agents/cron-tasks/${task.id}`);
  }
}

/**
 * Bind a server to port 0 (kernel-assigned ephemeral), read the port, then
 * close. There's a small race window between close and the test consumer
 * re-binding, but it's good enough for one-shot allocation.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to obtain ephemeral port')));
      }
    });
  });
}
