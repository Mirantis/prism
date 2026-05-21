/**
 * Tests for memory-store. The SQLite single-transaction dual-write shape
 * is covered here. The actual sqlite-vec query path needs a live DB, so we
 * inspect which `prepare()` statements flow through the better-sqlite3
 * handle — that's enough to guard against regressions where one of the
 * three writes escapes the transaction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  default: {
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

async function importFresh() {
  vi.resetModules();
  return import('./memory-store');
}

describe('memory-store', () => {
  beforeEach(() => {
    sqliteMock.prepareCalls = [];
    sqliteMock.transactionCalls = 0;
    sqliteMock.runImpls.clear();
  });

  it('rejects wrong-dimension embeddings', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    await expect(
      memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 128 }, () => 0.1)),
    ).rejects.toThrow(/dimensionality mismatch/);
  });

  it('issues UPDATE + DELETE + INSERT inside a single transaction', async () => {
    const { memoryEmbeddingStore } = await importFresh();

    await memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 1024 }, () => 0.1));

    // All three statements live on the better-sqlite3 handle.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
    expect(sqliteMock.prepareCalls[0]).toMatch(/^UPDATE memory_entries SET embedding/);
    expect(sqliteMock.prepareCalls[1]).toMatch(/^DELETE FROM memory_entry_vec/);
    expect(sqliteMock.prepareCalls[2]).toMatch(/^INSERT INTO memory_entry_vec/);
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
      memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 1024 }, () => 0.1)),
    ).rejects.toThrow(/vec0 full/);

    // All three statements attempted inside the same transaction; rollback
    // is better-sqlite3's guarantee once the callback throws.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
  });
});
