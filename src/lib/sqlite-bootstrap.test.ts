/**
 * Tests for sqlite-bootstrap: the sibling better-sqlite3 handle used for
 * sqlite-vec in single-agent mode. We run these against an in-memory SQLite
 * so the tests don't write anything to disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config', () => ({
  config: { databaseUrl: undefined as string | undefined },
}));

import { config } from '../config';

async function importFresh() {
  vi.resetModules();
  return import('./sqlite-bootstrap');
}

describe('sqlite-bootstrap', () => {
  beforeEach(() => {
    (config as { databaseUrl?: string }).databaseUrl = ':memory:';
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
});
