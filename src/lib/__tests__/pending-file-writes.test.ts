/**
 * Pending-file-writes registry tests.
 *
 * The registry exists so a reader in a step can wait for that step's writes to
 * the same file. What matters here is the bookkeeping: only the matching path is
 * waited for, a write that never settles is bounded by the timeout rather than
 * hanging the turn, and a step boundary cannot leave a waiter stranded.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPendingFileWrites } from '../pending-file-writes';

describe('createPendingFileWrites', () => {
  it('reports no pending write for a path nothing has registered', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_write_file', '/ws/other.md');

    await expect(registry.waitFor('/ws/draft.md', { timeoutMs: 50 })).resolves.toEqual({
      status: 'none',
    });
  });

  it('resolves once every write to that path has settled', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_write_file', '/ws/draft.md');
    registry.register('c2', 'shell_edit_file', '/ws/draft.md');

    const waiting = registry.waitFor('/ws/draft.md', { timeoutMs: 1000 });
    registry.settle('c1');
    registry.settle('c2');

    const outcome = await waiting;
    expect(outcome.status).toBe('settled');
    if (outcome.status !== 'settled') return;
    expect(outcome.toolNames).toEqual(['shell_write_file', 'shell_edit_file']);
  });

  it('keeps waiting while one of several writes to the path is outstanding', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_write_file', '/ws/draft.md');
    registry.register('c2', 'shell_edit_file', '/ws/draft.md');

    const waiting = registry.waitFor('/ws/draft.md', { timeoutMs: 30 });
    registry.settle('c1');

    // c2 never settles, so the bound is the timeout — not an early "settled".
    await expect(waiting).resolves.toMatchObject({ status: 'timeout' });
  });

  it('times out rather than hanging when a write never settles', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_edit_file', '/ws/draft.md');

    const outcome = await registry.waitFor('/ws/draft.md', { timeoutMs: 20 });
    expect(outcome.status).toBe('timeout');
    if (outcome.status === 'none') return;
    expect(outcome.toolNames).toEqual(['shell_edit_file']);
  });

  it('gives up immediately on an already-aborted turn', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_edit_file', '/ws/draft.md');
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.waitFor('/ws/draft.md', { timeoutMs: 10_000, abortSignal: controller.signal }),
    ).resolves.toMatchObject({ status: 'aborted' });
  });

  it('gives up when the turn is aborted while it is waiting', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_edit_file', '/ws/draft.md');
    const controller = new AbortController();

    const waiting = registry.waitFor('/ws/draft.md', {
      timeoutMs: 10_000,
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(waiting).resolves.toMatchObject({ status: 'aborted' });
  });

  it('treats settling an unknown call id as a no-op', () => {
    const registry = createPendingFileWrites();
    expect(() => registry.settle('never-registered')).not.toThrow();
    expect(() => registry.settle(undefined)).not.toThrow();
  });

  it('ignores a call with no id, since there is nothing to key it by', async () => {
    const registry = createPendingFileWrites();
    registry.register(undefined, 'shell_write_file', '/ws/draft.md');

    expect(registry.wasAnnounced(undefined)).toBe(false);
    await expect(registry.waitFor('/ws/draft.md', { timeoutMs: 20 })).resolves.toEqual({
      status: 'none',
    });
  });

  it('answers wasAnnounced for a write and for a plain announcement', () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_write_file', '/ws/draft.md');
    registry.announce('c2', 'share_file');

    expect(registry.wasAnnounced('c1')).toBe(true);
    expect(registry.wasAnnounced('c2')).toBe(true);
    expect(registry.wasAnnounced('c3')).toBe(false);
  });

  it('releases an outstanding waiter when the step boundary clears the registry', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_edit_file', '/ws/draft.md');

    const waiting = registry.waitFor('/ws/draft.md', { timeoutMs: 10_000 });
    registry.clear();

    // Without clear() resolving the deferred this would sit for the full timeout.
    await expect(waiting).resolves.toMatchObject({ status: 'settled' });
  });

  it('forgets announcements and writes across a step boundary', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_edit_file', '/ws/draft.md');
    registry.announce('c2', 'share_file');
    registry.clear();

    expect(registry.wasAnnounced('c1')).toBe(false);
    expect(registry.wasAnnounced('c2')).toBe(false);
    await expect(registry.waitFor('/ws/draft.md', { timeoutMs: 20 })).resolves.toEqual({
      status: 'none',
    });
  });

  it('matches paths exactly, so a prefix or a sibling never blocks', async () => {
    const registry = createPendingFileWrites();
    registry.register('c1', 'shell_write_file', '/ws/draft.md.bak');
    registry.register('c2', 'shell_write_file', '/ws/sub/draft.md');

    await expect(registry.waitFor('/ws/draft.md', { timeoutMs: 20 })).resolves.toEqual({
      status: 'none',
    });
  });

  it('reports how long the wait actually cost', async () => {
    vi.useFakeTimers();
    try {
      const registry = createPendingFileWrites();
      registry.register('c1', 'shell_edit_file', '/ws/draft.md');
      const waiting = registry.waitFor('/ws/draft.md', { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await waiting;
      expect(outcome.status).toBe('timeout');
      if (outcome.status === 'none') return;
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
