/**
 * Tests for memory-store. The provider selector (Postgres vs SQLite) and
 * the SQLite single-transaction dual-write shape are covered here.
 *
 * The actual pgvector / sqlite-vec query paths need a live DB, so for
 * SQLite we inspect which `prepare()` statements flow through the
 * better-sqlite3 handle — that's enough to guard against regressions
 * where one of the three writes escapes the transaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config', () => ({
  config: { singleAgentMode: false },
}));

vi.mock('../lib/prisma', () => ({
  default: {
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    memoryEntry: { findMany: vi.fn() },
  },
}));

// Shared spy state across tests so we can inspect prepare() calls.
const { sqliteMock } = vi.hoisted(() => {
  return {
    sqliteMock: {
      prepareCalls: [] as string[],
      transactionCalls: 0,
      runImpls: new Map<string, () => void>(),
    },
  };
});

vi.mock('../lib/sqlite-bootstrap', () => ({
  initSqliteVec: vi.fn(() => ({
    prepare: (sql: string) => {
      sqliteMock.prepareCalls.push(sql);
      return {
        run: (..._args: unknown[]) => {
          const impl = sqliteMock.runImpls.get(sql);
          if (impl) impl();
        },
        all: () => [],
      };
    },
    // better-sqlite3's transaction(fn) returns a function that, when called,
    // invokes fn inside a transaction. For the tests we invoke fn directly
    // so a throw surfaces as in the real API.
    transaction: (fn: () => void) => () => {
      sqliteMock.transactionCalls++;
      fn();
    },
  })),
  EMBEDDING_DIMENSION: 1024,
}));

import { config } from '../config';

async function importFresh() {
  vi.resetModules();
  return import('./memory-store');
}

describe('memory-store provider selector', () => {
  beforeEach(() => {
    (config as { singleAgentMode: boolean }).singleAgentMode = false;
    sqliteMock.prepareCalls = [];
    sqliteMock.transactionCalls = 0;
    sqliteMock.runImpls.clear();
  });

  it('selects the Postgres store by default', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    const prisma = (await import('../lib/prisma')).default;

    await memoryEmbeddingStore.storeEmbedding('entry-1', new Array(1024).fill(0.1));

    // Postgres path hits prisma.$executeRaw with vector cast SQL.
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('selects the SQLite store when singleAgentMode is true', async () => {
    (config as { singleAgentMode: boolean }).singleAgentMode = true;
    const { memoryEmbeddingStore } = await importFresh();
    const { initSqliteVec } = await import('../lib/sqlite-bootstrap');

    await memoryEmbeddingStore.storeEmbedding('entry-1', new Array(1024).fill(0.1));

    expect(initSqliteVec).toHaveBeenCalled();
  });

  it('rejects wrong-dimension embeddings', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    await expect(
      memoryEmbeddingStore.storeEmbedding('entry-1', new Array(128).fill(0.1)),
    ).rejects.toThrow(/dimensionality mismatch/);
  });
});

describe('memory-store SQLite single-transaction dual-write', () => {
  beforeEach(() => {
    (config as { singleAgentMode: boolean }).singleAgentMode = true;
    sqliteMock.prepareCalls = [];
    sqliteMock.transactionCalls = 0;
    sqliteMock.runImpls.clear();
  });

  it('issues UPDATE + DELETE + INSERT inside a single transaction', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    const prisma = (await import('../lib/prisma')).default;

    await memoryEmbeddingStore.storeEmbedding('entry-1', new Array(1024).fill(0.1));

    // All three statements live on the better-sqlite3 handle.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
    expect(sqliteMock.prepareCalls[0]).toMatch(/^UPDATE memory_entries SET embedding/);
    expect(sqliteMock.prepareCalls[1]).toMatch(/^DELETE FROM memory_entry_vec/);
    expect(sqliteMock.prepareCalls[2]).toMatch(/^INSERT INTO memory_entry_vec/);

    // The Prisma `$executeRaw` UPDATE path is gone for SQLite.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('propagates vec0 insert failure out of the transaction (so better-sqlite3 rolls back)', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    sqliteMock.runImpls.set(
      'INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)',
      () => {
        throw new Error('vec0 full');
      },
    );

    await expect(
      memoryEmbeddingStore.storeEmbedding('entry-1', new Array(1024).fill(0.1)),
    ).rejects.toThrow(/vec0 full/);

    // All three statements attempted inside the same transaction; rollback
    // is better-sqlite3's guarantee once the callback throws.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
  });
});
