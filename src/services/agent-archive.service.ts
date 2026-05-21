/**
 * Agent Archive Service
 *
 * Save-game / restore for a single-agent Prism container. A `.prism` file
 * is a gzipped copy of `/data/agent.db`. Export takes a consistent VACUUM
 * INTO snapshot (so live writes from heartbeat/cron don't tear the file).
 * Import gunzips to a private scratch file next to the live DB, validates
 * it, and only then atomic-renames to `/data/agent.db.next` — that one
 * file's existence is the entire pending-import protocol, no separate
 * marker. The caller then exits, and on next boot
 * `apply-pending-import.ts` (run by both `start.sh` in prod and the
 * `dev:single` npm script in dev) renames `.next` into place before any
 * process opens the DB.
 *
 * Validation on import: PRAGMA integrity_check + an exact match of the
 * applied Prisma migration set between the uploaded file and the runtime's
 * current DB. A mismatch is rejected up front so we never restart into a
 * file the runtime can't read.
 *
 * Two export entry points share the gzip/`VACUUM INTO` tail:
 *   - `exportAgent()` — single-agent mode, snapshots the live SQLite at
 *     `config.databaseUrl`.
 *   - `exportAgentFromPostgres()` — multi-tenant mode, materializes the
 *     agent's slice into a temp SQLite (via `prisma migrate deploy` +
 *     row-copy against the runtime's connected Postgres client) and
 *     snapshots that. `migrate deploy` populates `_prisma_migrations`,
 *     which the receiving runtime's import path requires.
 *     The on-disk format is identical, so the receiving single-agent
 *     container's import path accepts both interchangeably.
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
import { logger } from '../logger';
import { resolvePrismaSqlitePath } from '../lib/sqlite-path';
import { loadSqliteVec, EMBEDDING_DIMENSION } from '../lib/sqlite-bootstrap';
import { prisma } from '../lib/prisma';

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

  const stream = fs.createReadStream(snapshotPath).pipe(zlib.createGzip());
  const filename = `${slugify(agentName)}-${dateStamp(new Date())}.prism`;
  const cleanup = () => {
    fs.unlink(snapshotPath, () => {});
  };

  return { stream, filename, cleanup };
}

/**
 * pgvector comes out of Prisma raw queries as `"[0.1,0.2,…]"` (string).
 * Returns the unpacked numeric array, or null if the value is unrecognized.
 */
function unpackVector(pgValue: unknown): number[] | null {
  if (pgValue == null) return null;
  if (Array.isArray(pgValue)) return pgValue.map(Number);
  if (typeof pgValue !== 'string') return null;
  // pgvector text format `"[0.1,0.2,…]"` is a valid JSON array literal.
  try {
    const parsed = JSON.parse(pgValue);
    return Array.isArray(parsed) ? parsed.map(Number) : null;
  } catch {
    return null;
  }
}

/**
 * Prisma's read-type (`JsonValue`) and write-type (`InputJsonValue`) diverge
 * on JSON columns — reads may include `null`, writes demand `Prisma.JsonNull`.
 * We're copying rows between two Prisma clients of compatible schemas, so the
 * row shape is correct at runtime even if TypeScript disagrees. Cast once.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function castRows<T>(rows: T[]): any {
  return rows;
}

/**
 * Materialize one multi-tenant agent's slice from Postgres into a temp
 * SQLite, then return the same gzipped `VACUUM INTO` snapshot the single-
 * agent `exportAgent()` produces. Multi-tenant only — single-agent should
 * use `exportAgent()` directly against the live DB.
 *
 * Flow mirrors the now-retired `migrate-agent-to-sqlite.ts` CLI:
 *   1. `prisma migrate deploy --schema=prisma/sqlite/schema.prisma`
 *      against a fresh temp SQLite — `migrate deploy` (not `db push`)
 *      is what populates `_prisma_migrations`, which the receiving
 *      runtime's import path uses to confirm schema-version equality.
 *   2. Copy rows across via Prisma, in FK-dependency order.
 *   3. Pack pgvector embeddings into Float32Array BLOBs on the
 *      `memory_entries.embedding` column. The vec0 search index is
 *      runtime-ephemeral — the receiving runtime's sqlite-bootstrap
 *      rebuilds it on boot from these BLOBs.
 *   4. VACUUM INTO + gzip — same as `exportAgent()`.
 *
 * The caller is responsible for piping the returned stream to the HTTP
 * response and invoking `cleanup` on `close`.
 */
export async function exportAgentFromPostgres(agentId: string): Promise<{
  stream: NodeJS.ReadableStream;
  filename: string;
  cleanup: () => void;
}> {
  if (config.singleAgentMode) {
    throw new Error('exportAgentFromPostgres is multi-tenant only — use exportAgent() in single-agent mode');
  }

  const tempSqlitePath = path.resolve(os.tmpdir(), `prism-migrate-${randomUUID()}.db`);
  const tempSqliteUrl = `file:${tempSqlitePath}`;
  // Typed `any` because we use the full set of Prisma model accessors
  // (`.agentWorkspace`, `.conversationThread`, …) and the lazy
  // `require('.prisma/client-sqlite')` doesn't expose them through a
  // shared type. Runtime shape matches the Postgres client one-for-one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let liteClient: any = null;

  const cleanupTemps = (): void => safeUnlink(tempSqlitePath);

  try {
    // 1. Apply sqlite migrations to a fresh file. `migrate deploy` (not
    //    `db push`) is what populates `_prisma_migrations` — the import
    //    path on the receiving runtime cross-checks that table to confirm
    //    the archive's schema version matches its own, so the archive
    //    must carry the same migration set a fresh single-agent runtime
    //    produces on first boot.
    logger.info({ tempSqlitePath }, '[AgentArchive] applying sqlite migrations for Postgres export');
    const migrateResult = spawnSync(
      'npx',
      ['prisma', 'migrate', 'deploy', '--schema=prisma/sqlite/schema.prisma'],
      { env: { ...process.env, DATABASE_URL: tempSqliteUrl }, stdio: 'inherit' },
    );
    if (migrateResult.status !== 0) {
      throw new Error(`prisma migrate deploy failed (exit ${migrateResult.status})`);
    }

    // 2. Open a Prisma sqlite client against the temp file. Lazy require
    //    mirrors lib/prisma.ts — keeps vitest from resolving the path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PrismaClientSqlite } = require('.prisma/client-sqlite') as {
      PrismaClient: new (opts?: { datasources?: { db: { url: string } }; log?: string[] }) => unknown;
    };
    liteClient = new PrismaClientSqlite({
      datasources: { db: { url: tempSqliteUrl } },
      log: ['error'],
    });

    // 3. Agent first — every other table FKs to it.
    const agent = await prisma.agentWorkspace.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await liteClient.agentWorkspace.create({ data: agent });

    // 4. Conversations
    const threads = await prisma.conversationThread.findMany({ where: { agentId } });
    if (threads.length) {
      await liteClient.conversationThread.createMany({ data: castRows(threads) });
      const threadIds = threads.map((t) => t.id);
      const [messages, participants] = await Promise.all([
        prisma.conversationMessage.findMany({ where: { threadId: { in: threadIds } } }),
        prisma.conversationParticipant.findMany({ where: { threadId: { in: threadIds } } }),
      ]);
      if (messages.length) await liteClient.conversationMessage.createMany({ data: castRows(messages) });
      if (participants.length) await liteClient.conversationParticipant.createMany({ data: castRows(participants) });
    }

    // 5. Cron + Slack-side tables. `agent_subagents` is deliberately
    //    excluded — its rows FK both endpoints to `agent_workspaces`,
    //    and the cross-agent endpoint isn't in the temp DB. Single-agent
    //    runtimes don't support subagent linkage anyway (each agent
    //    lives in its own container), so dropping these rows on export
    //    matches the receiving runtime's reality.
    const [cronTasks, slackMappings, slackCodes, slackTriggers, pendingSlack] = await Promise.all([
      prisma.cronTask.findMany({ where: { agentId } }),
      prisma.slackMapping.findMany({ where: { agentId } }),
      prisma.slackVerificationCode.findMany({ where: { agentId } }),
      prisma.slackHeartbeatTrigger.findMany({ where: { agentId } }),
      prisma.pendingSlackMessage.findMany({ where: { agentId } }),
    ]);
    if (cronTasks.length) await liteClient.cronTask.createMany({ data: castRows(cronTasks) });
    if (slackMappings.length) await liteClient.slackMapping.createMany({ data: castRows(slackMappings) });
    if (slackCodes.length) await liteClient.slackVerificationCode.createMany({ data: castRows(slackCodes) });
    if (slackTriggers.length) await liteClient.slackHeartbeatTrigger.createMany({ data: castRows(slackTriggers) });
    if (pendingSlack.length) await liteClient.pendingSlackMessage.createMany({ data: castRows(pendingSlack) });

    // 6. Memory entries — metadata via Prisma + embeddings via raw SQL
    //    to get the pgvector value out as text.
    const memoryMeta = await prisma.memoryEntry.findMany({
      where: { agentId },
      select: {
        id: true,
        agentId: true,
        content: true,
        category: true,
        importance: true,
        createdAt: true,
      },
    });
    if (memoryMeta.length) {
      await liteClient.memoryEntry.createMany({ data: castRows(memoryMeta) });
    }
    const memoryWithVecs = await prisma.$queryRawUnsafe<
      Array<{ id: string; embedding: string | null }>
    >(
      `SELECT "id", "embedding"::text AS embedding FROM "memory_entries" WHERE "agentId" = $1`,
      agentId,
    );

    // Pack BLOBs via a direct better-sqlite3 handle. The vec0 search index
    // is intentionally NOT created — sqlite-bootstrap rebuilds it from
    // these BLOBs on the receiving runtime's boot.
    const rawDb = new Database(tempSqlitePath);
    rawDb.pragma('journal_mode = WAL');
    let vecRows = 0;
    const blobUpdate = rawDb.prepare(`UPDATE memory_entries SET embedding = ? WHERE id = ?`);
    for (const row of memoryWithVecs) {
      const arr = unpackVector(row.embedding);
      if (!arr || arr.length !== EMBEDDING_DIMENSION) continue;
      blobUpdate.run(Buffer.from(new Float32Array(arr).buffer), row.id);
      vecRows++;
    }
    rawDb.close();
    logger.info(
      { agentId, threads: threads.length, memoryMeta: memoryMeta.length, vecRows },
      '[AgentArchive] copied agent slice to temp sqlite',
    );

    // 7. VACUUM INTO + gzip — same shape as exportAgent().
    const snapshotPath = path.resolve(os.tmpdir(), `prism-export-${randomUUID()}.db`);
    const handle = new Database(tempSqlitePath, { readonly: true });
    try {
      handle.prepare(`VACUUM INTO ?`).run(snapshotPath);
    } finally {
      handle.close();
    }

    const stream = fs.createReadStream(snapshotPath).pipe(zlib.createGzip());
    const filename = `${slugify(agent.name)}-${dateStamp(new Date())}.prism`;
    const cleanup = () => {
      safeUnlink(snapshotPath);
      cleanupTemps();
    };

    return { stream, filename, cleanup };
  } catch (err) {
    cleanupTemps();
    throw err;
  } finally {
    if (liteClient) await liteClient.$disconnect();
  }
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

  // 3. Atomic rename — staging → `<db>.next`. From this point on, the
  // boot-time swap (`apply-pending-import.ts`) will pick it up. Rename
  // is atomic within the same filesystem; both paths sit in `liveDb`'s
  // directory by construction.
  fs.renameSync(stagingPath, dst);
  logger.info({ next: dst }, '[AgentArchive] staged import — restart will apply');
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
