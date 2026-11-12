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
import Database from 'better-sqlite3';
import { startRuntime, type RuntimeHandle } from './harness';


export interface RuntimeTestEnv {
  /** Temp directory holding the SQLite DB. */
  tempDir: string;
  /** Absolute path to the SQLite DB file. */
  dbPath: string;
  /** Port the runtime is listening on. */
  port: number;
  /** Port the runtime takes other agents' messages on. */
  agentMessagesPort: number;
  /** Env block to pass to `startPrism({ env })`. */
  prismEnv: NodeJS.ProcessEnv;
  /** Handle to the running agent-runtime process — pass to startPrism for log tailing in error messages. */
  runtime: RuntimeHandle;
  /** Stop the runtime and start it again on the same database, env and port, as a deploy does. */
  restart(): Promise<void>;
  /** Stop the runtime and remove the temp dir. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

export interface SetupOptions {
  /** Extra env to layer onto the prism env (useful for per-test overrides). */
  prismEnvOverrides?: Record<string, string | undefined>;
  /**
   * Extra env to layer onto the agent-runtime process (e.g.
   * SHELL_WORKSPACE_ROOT so the agent can create files in a writable temp dir
   * instead of the `/home/node` default). Undefined values are dropped by the
   * harness's env sanitizer.
   */
  runtimeEnvOverrides?: Record<string, string | undefined>;
}

export async function setupRuntime(opts: SetupOptions = {}): Promise<RuntimeTestEnv> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-'));
  const dbPath = path.join(tempDir, 'agent.db');
  const port = await findFreePort();
  // Its own free port, so runtimes started side by side do not contend for the default.
  const agentMessagesPort = await findFreePort([port]);

  // The runtime creates the database on its first boot, from the migrations it carries.
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}`,
    PORT: String(port),
    AGENT_MESSAGES_PORT: String(agentMessagesPort),
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
    // Pin the model catalog to the bundled snapshot. Off by default, but this
    // spreads process.env above, so a developer who opts in via .env would
    // otherwise leak the refresh into the suite.
    MODELS_DEV_URL: '',
    // Pinned, not derived: CI runners have a container engine, so the suite
    // would otherwise run the agent's commands in a container on CI and on the
    // host locally, which is two different tests under one name.
    EXECUTION_ENVIRONMENT: 'local',
    ...(opts.runtimeEnvOverrides ?? {}),
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
  const testEnv: RuntimeTestEnv = {
    tempDir,
    dbPath,
    port,
    agentMessagesPort,
    prismEnv,
    runtime,
    async restart() {
      await runtime.kill();
      runtime = startRuntime({ env: runtimeEnv });
      testEnv.runtime = runtime;
      await runtime.waitForReady(60_000);
    },
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
  return testEnv;
}

/**
 * Wipe conversation rows so subsequent tests in the same file see a clean
 * thread without rebooting the runtime. The thread row itself is preserved
 * so `getOrCreateLatestThread()` keeps the same id — but its per-conversation
 * state columns (compaction summary/watermark, context-usage snapshot) are
 * cleared, or a compaction from one test would leak its summary into the next.
 */
export function resetThread(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('DELETE FROM conversation_messages;');
    db.exec(
      `UPDATE conversation_threads SET
         compactionSummary = NULL,
         compactedAt = NULL,
         compactedThroughTs = NULL,
         contextTokens = NULL,
         contextModel = NULL;`,
    );
  } finally {
    db.close();
  }
}

/**
 * Count stored conversation rows for a role, straight from SQLite.
 *
 * Authoritative check that a message the user sent actually became history —
 * the frame only shows what was rendered.
 */
export function countMessages(dbPath: string, role: 'USER' | 'AGENT'): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE role = ?')
      .get(role) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/**
 * How many rows of `role` contain `text`.
 *
 * Exported for the assertions that need a sentinel to be *absent*:
 * `waitForStoredMessage` only proves presence, and `session.output()` is a
 * wrapped, truncated frame buffer rather than the stored message.
 */
export function countMessagesContaining(dbPath: string, role: 'USER' | 'AGENT', text: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE role = ? AND content LIKE ?')
      .get(role, `%${text}%`) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/**
 * Wait until at least one stored `role` message contains `text`.
 *
 * Use this rather than `waitForFrame` when the text also appears in something the
 * *client* renders — a draft in the composer, or the echo of the user's own
 * line. Those satisfy a frame matcher the moment they are typed, so a frame
 * match proves nothing about a reply. A row of the right role does.
 */
export async function waitForStoredMessage(
  dbPath: string,
  role: 'USER' | 'AGENT',
  text: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (countMessagesContaining(dbPath, role, text) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `No ${role} message containing "${text}" after ${timeoutMs}ms ` +
          `(${countMessages(dbPath, role)} ${role} row(s) stored)`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Wait for the stored count of `role` to reach `expected`.
 *
 * A message is stored by the runtime, so sampling the count the instant the
 * screen changes races the write.
 */
export async function waitForMessageCount(
  dbPath: string,
  role: 'USER' | 'AGENT',
  expected: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = countMessages(dbPath, role);
    if (n >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`Expected ${expected} ${role} message(s), found ${n} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Wait until `expected` delivered agent replies have at least one attachment.
 *
 * A turn's shared files are linked to its final reply. `internalStep` rows are
 * stored mid-turn, before that reply, so a plain AGENT count can grow while the
 * new attachment does not exist yet.
 */
export async function waitForAgentRepliesWithAttachments(
  dbPath: string,
  expected: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = countAgentRepliesWithAttachments(dbPath);
    if (n >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`Expected ${expected} agent reply(s) with attachments, found ${n} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function countAgentRepliesWithAttachments(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversation_messages m
         WHERE m.role = 'AGENT' AND m.internalStep = 0
           AND EXISTS (SELECT 1 FROM message_attachments a WHERE a.messageId = m.id)`,
      )
      .get() as { n: number };
    return row.n;
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
 * re-binding, but it's good enough for one-shot allocation. A port in
 * `exclude` (one already handed out for the same runtime, which nothing has
 * bound yet) is skipped, since the kernel may hand it out again.
 */
export async function findFreePort(exclude: readonly number[] = []): Promise<number> {
  for (;;) {
    const port = await bindEphemeralPort();
    if (!exclude.includes(port)) return port;
  }
}

function bindEphemeralPort(): Promise<number> {
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
