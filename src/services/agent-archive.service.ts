/**
 * Agent Archive Service
 *
 * Save-game / restore for a Prism Agent container. A `.prism` file is a
 * gzipped copy of `/data/agent.db`. Export takes a consistent VACUUM
 * INTO snapshot (so live writes from heartbeat/cron don't tear the
 * file). Import gunzips to a private scratch file next to the live DB,
 * validates it, and only then atomic-renames to `/data/agent.db.next`
 * — that one file's existence is the entire pending-import protocol,
 * no separate marker. The caller then exits, and on next boot
 * `apply-pending-import.ts` (run by both `start.sh` in prod and the
 * `dev:single` npm script in dev) renames `.next` into place before any
 * process opens the DB.
 *
 * Validation on import: PRAGMA integrity_check + an exact match of the
 * applied Prisma migration set between the uploaded file and the
 * runtime's current DB. A mismatch is rejected up front so we never
 * restart into a file the runtime can't read.
 *
 * `exportAgent()` snapshots the live SQLite at `config.databaseUrl`.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { resolvePrismaSqlitePath } from '../lib/sqlite-path';
import {
  CHATGPT_AUTH_CLIENT_ID,
  CHATGPT_AUTH_HOST_ID,
  CHATGPT_AUTH_TOKENS,
} from './runtime-state.service';

/**
 * Per-install ChatGPT OAuth rows that must never leave the machine in a backup
 * or be restored onto another install (restoring a shared refresh token causes
 * token rotation conflicts and leaks live credentials in `.prism` archives).
 */
const STRIPPED_RUNTIME_STATE_KEYS = [
  CHATGPT_AUTH_TOKENS,
  CHATGPT_AUTH_HOST_ID,
  CHATGPT_AUTH_CLIENT_ID,
] as const;

function stripHostAuthState(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const hasTable = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_state'`)
      .get();
    if (!hasTable) return;
    const placeholders = STRIPPED_RUNTIME_STATE_KEYS.map(() => '?').join(', ');
    db.prepare(`DELETE FROM runtime_state WHERE key IN (${placeholders})`).run(
      ...STRIPPED_RUNTIME_STATE_KEYS,
    );
  } finally {
    db.close();
  }
}
import { loadSqliteVec, EMBEDDING_DIMENSION } from '../lib/sqlite-bootstrap';

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

function resolveDbPath(): string {
  return resolvePrismaSqlitePath(config.databaseUrl);
}

function nextDbPath(): string {
  return `${resolveDbPath()}.next`;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function dateStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function getAppliedMigrations(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`)
    .all() as Array<{ migration_name: string }>;
  return new Set(rows.map((r) => r.migration_name));
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Export the current agent DB to a gzipped readable stream + suggested
 * filename. Caller is responsible for piping the stream to the HTTP
 * response and unlinking the temp snapshot on `close`.
 */
export async function exportAgent(agentName: string): Promise<{
  stream: NodeJS.ReadableStream;
  filename: string;
  cleanup: () => void;
}> {
  const src = resolveDbPath();
  if (!fs.existsSync(src)) {
    throw new Error(`Agent database not found at ${src}`);
  }

  const snapshotPath = path.join(os.tmpdir(), `prism-export-${randomUUID()}.db`);

  // VACUUM INTO produces a self-contained, consistent snapshot — safe even
  // while Prisma is mid-write on the live DB. The live DB carries a
  // `memory_entry_vec` virtual table (rebuilt by sqlite-bootstrap each
  // boot), so the handle must load sqlite-vec before VACUUM walks every
  // table's schema — otherwise it fails with `no such module: vec0`.
  const handle = new Database(src, { readonly: true });
  try {
    loadSqliteVec(handle);
    handle.prepare(`VACUUM INTO ?`).run(snapshotPath);
  } finally {
    handle.close();
  }

  // Strip host-bound OAuth credentials from the snapshot so `.prism` backups
  // never carry live ChatGPT refresh tokens or collide on host/client IDs.
  stripHostAuthState(snapshotPath);

  const stream = fs.createReadStream(snapshotPath).pipe(zlib.createGzip());
  const filename = `${slugify(agentName)}-${dateStamp(new Date())}.prism`;
  const cleanup = () => {
    fs.unlink(snapshotPath, () => {});
  };

  return { stream, filename, cleanup };
}


/**
 * Stage an uploaded `.prism` for the next process restart.
 *
 * Steps:
 *   1. Gunzip the buffer to a private `.import-staging-<uuid>.db` next
 *      to the live DB.
 *   2. Open it with `better-sqlite3` read-only, run `PRAGMA integrity_check`,
 *      and confirm the applied migration set matches the current DB.
 *   3. Atomic-rename the validated file to `<liveDb>.next`. That rename is
 *      the entire signal — `apply-pending-import.ts` checks only `.next`.
 *
 * Throws `ArchiveValidationError` for user-facing rejections; the caller
 * should surface those as 400s. Cleans up the staging file on rejection so
 * partial writes never land at `.next`.
 */
export async function importAgent(buffer: Buffer): Promise<void> {
  const liveDb = resolveDbPath();
  const dst = nextDbPath();

  // gunzip to a unique scratch file in the same directory as the live DB,
  // not directly to `<db>.next`. The atomic `fs.renameSync` at the end is
  // the signal a pending import is ready — its absence means there's
  // either nothing staged or staging didn't complete, so the boot-time
  // swap path has no marker file to coordinate with.
  const stagingPath = path.join(
    path.dirname(liveDb),
    `.import-staging-${randomUUID()}.db`,
  );

  // 1. gunzip → staging
  try {
    await pipeline(Readable.from(buffer), zlib.createGunzip(), fs.createWriteStream(stagingPath));
  } catch (err) {
    safeUnlink(stagingPath);
    throw new ArchiveValidationError(
      `Failed to decompress archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Validate the staged file before promoting it. Both handles need
  // sqlite-vec loaded — the staged file is a normal `.prism` export from
  // a running runtime so it carries the `memory_entry_vec` virtual table,
  // and the live DB has the same table from this runtime's own
  // `sqlite-bootstrap` rebuild on boot. Without the extension,
  // `PRAGMA integrity_check` errors on `no such module: vec0`.
  let staged: Database.Database | null = null;
  let live: Database.Database | null = null;
  try {
    staged = new Database(stagingPath, { readonly: true });
    loadSqliteVec(staged);
    live = new Database(liveDb, { readonly: true });
    loadSqliteVec(live);

    const integrity = (staged.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string } | undefined)
      ?.integrity_check;
    if (integrity !== 'ok') {
      throw new ArchiveValidationError(
        `Uploaded database failed integrity check: ${integrity ?? 'unknown'}`,
      );
    }

    const stagedMigrations = getAppliedMigrations(staged);
    const liveMigrations = getAppliedMigrations(live);
    if (!setsEqual(stagedMigrations, liveMigrations)) {
      const onlyInStaged = [...stagedMigrations].filter((m) => !liveMigrations.has(m));
      const onlyInLive = [...liveMigrations].filter((m) => !stagedMigrations.has(m));
      throw new ArchiveValidationError(
        `Schema version mismatch — the backup was taken against a different runtime version. ` +
          `Only in backup: [${onlyInStaged.join(', ') || 'none'}]. ` +
          `Only in current: [${onlyInLive.join(', ') || 'none'}].`,
      );
    }
  } catch (err) {
    safeUnlink(stagingPath);
    if (err instanceof ArchiveValidationError) throw err;
    throw new ArchiveValidationError(
      `Failed to validate archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    staged?.close();
    live?.close();
  }

  // Strip host-bound OAuth credentials from older backups before promoting.
  stripHostAuthState(stagingPath);

  // 3. Atomic rename — staging → `<db>.next`. From this point on, the
  // boot-time swap (`apply-pending-import.ts`) will pick it up. Rename
  // is atomic within the same filesystem; both paths sit in `liveDb`'s
  // directory by construction.
  fs.renameSync(stagingPath, dst);
  logger.info({ next: dst }, '[AgentArchive] staged import — restart will apply');

  // Best-effort: the process restarts shortly after staging, so this may not
  // flush — losing it never affects the import itself.
  trackEvent('agent imported', null, {
    ...(config.agentId ? { 'agent.id': config.agentId } : {}),
  });
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    // Don't throw — every caller is in a cleanup/finally path where
    // bubbling would mask the real error. Log so the failure is at
    // least visible during debugging (missing-file ENOENT is common
    // and uninteresting, so skip those).
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno !== 'ENOENT') {
      logger.warn({ err, path: p }, '[AgentArchive] safeUnlink failed');
    }
  }
}
