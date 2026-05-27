/**
 * Entry point for the packaged `prism-server` binary (Node SEA).
 *
 * Replaces the responsibilities of start.sh for a standalone install:
 *   1. Default DATABASE_URL → ~/.prism/agent.db and PRISM_WEB_DIR → sidecar web/.
 *   2. Promote any staged `.prism` restore before the DB is opened.
 *   3. Apply migrations directly via better-sqlite3 (no Prisma CLI in the binary).
 *   4. Kick off the embedding backfill in the background (best-effort).
 *   5. Boot the runtime (src/index.ts: HTTP + WS + heartbeats + cron + Slack).
 *
 * Native deps (better-sqlite3, @prisma/client, sqlite-vec) are NOT bundled —
 * they load from the `node_modules/` sidecar next to this executable.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import migrations from 'virtual:migrations';
import { applyMigrations } from './migrate';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(process.env.PRISM_VERSION ?? '0.0.0-dev');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'prism-server — Prism agent runtime (HTTP + WebSocket on :3003, serves the bundled web UI).',
  );
  process.exit(0);
}

// Standalone-install defaults — only set when the operator/service hasn't.
process.env.NODE_ENV ??= 'production';

const dataDir = path.join(os.homedir(), '.prism');
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATABASE_URL ??= `file:${path.join(dataDir, 'agent.db')}`;

// Sidecars (web/, node_modules/) live next to the executable.
process.env.PRISM_WEB_DIR ??= path.join(path.dirname(process.execPath), 'web');

async function main(): Promise<void> {
  // 1. Promote any staged `.prism` restore before anything opens the DB.
  await import('../scripts/apply-pending-import.js');

  // 2. Apply migrations (Prisma-CLI-free). better-sqlite3 loads from the
  //    sidecar node_modules, so import it lazily (keeps --version standalone).
  const { default: Database } = await import('better-sqlite3');
  const dbPath = process.env.DATABASE_URL!.replace(/^file:/, '');
  const db = new Database(dbPath);
  try {
    const done = applyMigrations(db, migrations);
    if (done.length > 0) {
      process.stderr.write(`[prism-server] applied ${done.length} migration(s)\n`);
    }
  } finally {
    db.close();
  }

  // 3. Embedding backfill — best-effort, never blocks startup.
  void import('../scripts/backfill-embeddings.js').catch(() => {});

  // 4. Boot the runtime.
  await import('../index.js');
}

main().catch((err) => {
  console.error('[prism-server] fatal startup error', err);
  process.exit(1);
});
