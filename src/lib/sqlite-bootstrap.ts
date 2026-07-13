/**
 * SQLite bootstrap.
 *
 * Prisma's bundled SQLite engine refuses `SELECT load_extension(...)` ("not
 * authorized"), so we keep a sibling `better-sqlite3` connection open
 * against the same DB file for the vector operations. Prisma owns the
 * regular tables; `better-sqlite3` + sqlite-vec owns the `memory_entry_vec`
 * virtual table. WAL mode allows both to coexist safely.
 *
 * This module:
 *   - opens the better-sqlite3 handle against DATABASE_URL (expected
 *     `file:…`)
 *   - loads the sqlite-vec loadable extension
 *   - enables WAL + foreign keys
 *   - ensures the `memory_entry_vec` virtual table exists
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config';
import { logger } from '../logger';
import { resolvePrismaSqlitePath } from './sqlite-path';

const EMBEDDING_DIM = 1024;

let handle: Database.Database | null = null;

/**
 * Initialize the sqlite-vec handle + virtual table. Safe to call more than
 * once — subsequent calls are no-ops.
 */
export function initSqliteVec(): Database.Database {
  if (handle) return handle;

  const path = resolvePrismaSqlitePath(config.databaseUrl);
  logger.info({ path }, '[SqliteBootstrap] opening database for vec operations');

  const db = new Database(path);
  sqliteVec.load(db);

  // WAL so Prisma's writes and our vec writes don't block each other.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = (db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined)?.v;
  logger.info({ version }, '[SqliteBootstrap] sqlite-vec loaded');

  // Invalidate stored vectors when the embedding provider/model changes, so a
  // reused /data volume never compares vectors from different embedding spaces.
  // Runs before the vec0 rebuild below so the rebuild sees the nulled BLOBs.
  reconcileEmbeddingSignature(db);

  // vec0 is a runtime index — rebuilt from the Prisma-owned
  // `memory_entries.embedding` BLOB column on every boot. The durable
  // BLOBs in `memory_entries` are the source of truth; this is cheap
  // (microseconds per row) and self-healing.
  //
  // We DROP + CREATE on every boot rather than `IF NOT EXISTS` so any
  // schema change in this file (e.g. distance metric, dimension) takes
  // effect on the next process start without operator intervention.
  // sqlite-vec defaults `distance_metric` to L2 — explicitly request
  // cosine here because Titan v2 produces unit-normalized vectors and
  // the rest of the stack (`memory-store.ts` threshold conversion,
  // pgvector parity) is built around cosine distance.
  //
  // FIXME(memory-rebuild-scale): unconditional rebuild is fine for the
  // realistic scale per agent (hundreds–low thousands of entries =
  // sub-second cold start) but becomes an issue at 10k+ entries
  // (seconds → tens of seconds). Likely fix is a schema-version sentinel
  // (e.g. `pragma user_version`) that skips the rebuild when the
  // existing vec0 already matches the current expected version. Punted
  // because we expect to revisit the memory system architecture before
  // agents accumulate that much memory.
  db.exec(`DROP TABLE IF EXISTS memory_entry_vec`);
  db.exec(
    `CREATE VIRTUAL TABLE memory_entry_vec USING vec0(
       memory_entry_id TEXT PRIMARY KEY,
       embedding float[${EMBEDDING_DIM}] distance_metric=cosine
     )`,
  );

  rebuildVec0Index(db);

  handle = db;
  return handle;
}

/**
 * Embedding vectors are only comparable within one embedding space. A stored
 * vector carries no provenance, and the startup backfill only fills rows where
 * `embedding IS NULL` — so reusing a /data volume across a provider or
 * embedding-model change would silently compare vectors from different spaces
 * (both are 1024-dim, so there is no dimension error, just meaningless search).
 *
 * We record a signature (`provider:model:dim`) in a tiny meta table on this
 * same raw handle — like `memory_entry_vec`, it lives outside Prisma's schema
 * and needs no migration. When the signature changes we null the durable BLOBs
 * so the vec0 rebuild starts empty and the startup backfill regenerates every
 * vector with the now-active model.
 *
 * First boot (no stored signature) records the signature without wiping: a
 * volume created before this shipped has valid vectors we must not nuke.
 */
function reconcileEmbeddingSignature(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS embedding_meta (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT)`,
  );

  const current = `${config.llmProvider}:${config.embeddingModelId || '(none)'}:${EMBEDDING_DIM}`;
  const stored = (
    db.prepare(`SELECT signature FROM embedding_meta WHERE id = 1`).get() as
      | { signature: string | null }
      | undefined
  )?.signature;

  if (stored != null && stored !== current) {
    // Defensive: `memory_entries` exists in a normal boot (migrate deploy runs
    // first), but guard for bare test setups that bypass start.sh.
    const hasMemoryEntries = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'`)
      .get();
    const invalidated = hasMemoryEntries
      ? db.prepare(`UPDATE memory_entries SET embedding = NULL WHERE embedding IS NOT NULL`).run()
          .changes
      : 0;
    logger.warn(
      { from: stored, to: current, invalidated },
      '[SqliteBootstrap] embedding signature changed — invalidated stored vectors; will rebuild on backfill',
    );
  }

  db.prepare(
    `INSERT INTO embedding_meta (id, signature) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET signature = excluded.signature`,
  ).run(current);
}

function rebuildVec0Index(db: Database.Database): void {
  // Defensive: in normal boot, `start.sh` runs `prisma migrate deploy`
  // before this code, so `memory_entries` always exists. This guard only
  // matters for bare test setups or future call sites that bypass
  // start.sh.
  const hasMemoryEntries = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'`)
    .get();
  if (!hasMemoryEntries) return;

  const rows = db
    .prepare(`SELECT id, embedding FROM memory_entries WHERE embedding IS NOT NULL`)
    .all() as Array<{ id: string; embedding: Buffer | null }>;

  const insert = db.prepare(
    `INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)`,
  );
  const tx = db.transaction(() => {
    let added = 0;
    for (const row of rows) {
      if (!row.embedding) continue;
      // Sanity: each BLOB should be EMBEDDING_DIM * 4 bytes (Float32).
      if (row.embedding.length !== EMBEDDING_DIM * 4) continue;
      insert.run(row.id, row.embedding);
      added++;
    }
    return added;
  });
  const added = tx();
  if (added > 0) {
    logger.info({ added, total: rows.length }, '[SqliteBootstrap] rebuilt vec0 index from BLOBs');
  }
}

/**
 * Load the sqlite-vec extension on a foreign handle. Needed by any code that
 * opens its own `better-sqlite3` connection to the live DB and runs schema-
 * level ops (`VACUUM INTO`, `PRAGMA integrity_check`, etc.) — without the
 * extension, those fail with `no such module: vec0` on the `memory_entry_vec`
 * virtual table that `initSqliteVec()` persists in the file.
 */
export function loadSqliteVec(db: Database.Database): void {
  sqliteVec.load(db);
}

/**
 * Access the initialized handle. Throws if init has not been called.
 */
export function getSqliteVec(): Database.Database {
  if (!handle) {
    throw new Error('SQLite vec handle is not initialized — call initSqliteVec() first');
  }
  return handle;
}

/**
 * Close the sqlite-vec handle (best-effort, graceful-shutdown path).
 */
export function closeSqliteVec(): void {
  if (handle) {
    try {
      handle.close();
    } catch (err) {
      logger.warn({ err }, '[SqliteBootstrap] close failed');
    }
    handle = null;
  }
}

export const EMBEDDING_DIMENSION = EMBEDDING_DIM;
