/**
 * Database Thread Provider Tests
 *
 * The provider serves two views (see thread-provider.interface.ts): the model
 * view hides compacted rows (their content lives in the compaction summary)
 * while the client view keeps them so users scroll the full thread — it hides
 * only concise-mode internal steps.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));
vi.mock('../../lib/prisma', () => ({
  default: { conversationMessage: { findMany: mockFindMany } },
}));

import { DatabaseThreadProvider } from '../providers/database-thread.provider';

const provider = new DatabaseThreadProvider();

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
});

describe('DatabaseThreadProvider views', () => {
  it('model view filters compacted rows and keeps internal steps', async () => {
    await provider.getMessages('t1');

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { threadId: 't1', isCompacted: false },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('client view keeps compacted rows and hides internal steps', async () => {
    await provider.getMessages('t1', { excludeInternal: true });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { threadId: 't1', internalStep: false },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('getRecentMessages applies the same two views inside the WHERE clause', async () => {
    await provider.getRecentMessages('t1', 5);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { threadId: 't1', isCompacted: false },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    await provider.getRecentMessages('t1', 5, { excludeInternal: true });
    expect(mockFindMany).toHaveBeenLastCalledWith({
      where: { threadId: 't1', internalStep: false },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  });

  it('getRecentMessages returns rows in chronological order', async () => {
    mockFindMany.mockResolvedValue([{ id: 'newest' }, { id: 'older' }]);
    const rows = await provider.getRecentMessages('t1', 2);
    expect(rows.map((r) => r.id)).toEqual(['older', 'newest']);
  });
});
