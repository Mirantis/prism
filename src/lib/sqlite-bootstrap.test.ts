/**
 * Tests for sqlite-bootstrap: the sibling better-sqlite3 handle used for
 * sqlite-vec. We run these against an in-memory SQLite so the tests
 * don't write anything to disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config', () => ({
  config: {
    databaseUrl: undefined as string | undefined,
    llmProvider: 'bedrock' as 'bedrock' | 'azure',
    embeddingModelId: 'amazon.titan-embed-text-v2:0' as string,
  },
}));

import { config } from '../config';

type MockConfig = {
  databaseUrl?: string;
  llmProvider: 'bedrock' | 'azure';
  embeddingModelId: string;
};
const mockConfig = config as unknown as MockConfig;

async function importFresh() {
  vi.resetModules();
  return import('./sqlite-bootstrap');
}

describe('sqlite-bootstrap', () => {
  beforeEach(() => {
    mockConfig.databaseUrl = ':memory:';
    mockConfig.llmProvider = 'bedrock';
    mockConfig.embeddingModelId = 'amazon.titan-embed-text-v2:0';
  });

  afterEach(async () => {
    const mod = await import('./sqlite-bootstrap');
    mod.closeSqliteVec();
  });

  it('opens a handle with sqlite-vec loaded', async () => {
    const { initSqliteVec } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
    const db = initSqliteVec();
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string };
    expect(row.v).toMatch(/^v\d+\./);
  });

  it('creates the memory_entry_vec virtual table', async () => {
    const { initSqliteVec } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
    const db = initSqliteVec();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' OR type='virtual' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('memory_entry_vec');
  });

  it('supports INSERT + MATCH for KNN search', async () => {
    const { initSqliteVec, EMBEDDING_DIMENSION } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
    const db = initSqliteVec();

    // Seed with three small (we use a tiny test dimension table instead of the
    // production 1024-d schema so the test stays fast). We create our own test
    // virtual table to avoid tangling with the production one.
    db.exec(`CREATE VIRTUAL TABLE t_vec USING vec0(id TEXT PRIMARY KEY, emb float[3])`);
    const ins = db.prepare('INSERT INTO t_vec(id, emb) VALUES (?, ?)');
    const packed = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    ins.run('a', packed([1, 0, 0]));
    ins.run('b', packed([0, 1, 0]));
    ins.run('c', packed([0.9, 0.1, 0]));

    const rows = db
      .prepare(`SELECT id, distance FROM t_vec WHERE emb MATCH ? ORDER BY distance LIMIT 2`)
      .all(packed([1, 0, 0])) as Array<{ id: string; distance: number }>;

    expect(rows[0].id).toBe('a');
    expect(rows[0].distance).toBe(0);
    expect(rows[1].id).toBe('c');
    expect(EMBEDDING_DIMENSION).toBe(1024);
  });

  it('is idempotent — second init returns the same handle', async () => {
    const { initSqliteVec } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
    const first = initSqliteVec();
    const second = initSqliteVec();
    expect(second).toBe(first);
  });

  it('throws when DATABASE_URL is unset', async () => {
    const { initSqliteVec } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = undefined;
    expect(() => initSqliteVec()).toThrow(/DATABASE_URL is required/);
  });

  it('memory_entry_vec uses cosine distance (not the L2 default)', async () => {
    // Distinguish L2 from cosine using direction-only differences:
    //   query  = [1, 0]
    //   close  = [10, 0]   — same direction (cos sim 1.0), L2 distance 9
    //   right  = [1, 1]    — 45° off  (cos sim ~0.707), L2 distance 1
    // Under L2: `right` (dist 1) is closer than `close` (dist 9).
    // Under cosine: `close` (dist 0) is closer than `right` (dist ~0.293).
    const { initSqliteVec } = await importFresh();
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
    const db = initSqliteVec();

    const packed = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    const ins = db.prepare('INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)');
    // Pad to the production dimension (1024) so vec0 accepts the BLOB.
    const pad = (head: number[]) => [...head, ...new Array(1024 - head.length).fill(0)];
    ins.run('close', packed(pad([10, 0])));
    ins.run('right', packed(pad([1, 1])));

    const rows = db
      .prepare(
        `SELECT memory_entry_id AS id, distance FROM memory_entry_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 2`,
      )
      .all(packed(pad([1, 0]))) as Array<{ id: string; distance: number }>;

    expect(rows[0].id).toBe('close');
    expect(rows[0].distance).toBeCloseTo(0, 5);
    expect(rows[1].id).toBe('right');
  });

  describe('embedding signature invalidation', () => {
    // These cross-boot cases need durable state, so they run against a temp
    // file rather than the module-default :memory: DB (fresh on every open).
    let tmpDir: string;
    let dbFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-vec-'));
      dbFile = path.join(tmpDir, 'agent.db');
      mockConfig.databaseUrl = `file:${dbFile}`;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Seed a `memory_entries` row with a non-null 1024-dim embedding BLOB. */
    function seedEmbeddedEntry(): void {
      const raw = new Database(dbFile);
      raw.exec(
        `CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, embedding BLOB)`,
      );
      const blob = Buffer.from(new Float32Array(Array.from({ length: 1024 }, () => 0.1)).buffer);
      raw.prepare(`INSERT INTO memory_entries (id, embedding) VALUES ('m1', ?)`).run(blob);
      raw.close();
    }

    async function boot(provider: 'bedrock' | 'azure' = 'bedrock', model = 'amazon.titan-embed-text-v2:0') {
      const mod = await importFresh();
      // Set config fields AFTER importFresh — vi.resetModules() re-evaluates the
      // config mock, so these must be applied to the object the fresh module reads.
      mockConfig.databaseUrl = `file:${dbFile}`;
      mockConfig.llmProvider = provider;
      mockConfig.embeddingModelId = model;
      const db = mod.initSqliteVec();
      return { mod, db };
    }

    it('records the signature on first boot without wiping existing vectors', async () => {
      seedEmbeddedEntry();
      const { db } = await boot();

      const sig = db.prepare(`SELECT signature FROM embedding_meta WHERE id = 1`).get() as {
        signature: string;
      };
      expect(sig.signature).toBe('bedrock:amazon.titan-embed-text-v2:0:1024');
      // Pre-existing vector preserved (a #62 volume has no signature yet).
      const row = db.prepare(`SELECT embedding FROM memory_entries WHERE id = 'm1'`).get() as {
        embedding: Buffer | null;
      };
      expect(row.embedding).not.toBeNull();
      const vecCount = db.prepare(`SELECT count(*) AS n FROM memory_entry_vec`).get() as { n: number };
      expect(vecCount.n).toBe(1);
    });

    it('invalidates stored vectors when the provider/model changes', async () => {
      seedEmbeddedEntry();
      const first = await boot();
      first.mod.closeSqliteVec();

      // Switch provider — signature changes.
      const { db } = await boot('azure', 'text-embedding-3-small');

      const row = db.prepare(`SELECT embedding FROM memory_entries WHERE id = 'm1'`).get() as {
        embedding: Buffer | null;
      };
      expect(row.embedding).toBeNull(); // wiped → backfill will regenerate
      const vecCount = db.prepare(`SELECT count(*) AS n FROM memory_entry_vec`).get() as { n: number };
      expect(vecCount.n).toBe(0);
      const sig = db.prepare(`SELECT signature FROM embedding_meta WHERE id = 1`).get() as {
        signature: string;
      };
      expect(sig.signature).toBe('azure:text-embedding-3-small:1024');
    });

    it('preserves stored vectors when the signature is unchanged', async () => {
      seedEmbeddedEntry();
      const first = await boot();
      first.mod.closeSqliteVec();

      const { db } = await boot(); // same provider/model
      const row = db.prepare(`SELECT embedding FROM memory_entries WHERE id = 'm1'`).get() as {
        embedding: Buffer | null;
      };
      expect(row.embedding).not.toBeNull();
      const vecCount = db.prepare(`SELECT count(*) AS n FROM memory_entry_vec`).get() as { n: number };
      expect(vecCount.n).toBe(1);
    });
  });
});
