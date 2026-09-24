import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFindLatestThread } = vi.hoisted(() => ({ mockFindLatestThread: vi.fn() }));

vi.mock('../conversation.service', () => ({
  conversationService: { findLatestThread: mockFindLatestThread },
}));

vi.mock('../../logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { turnActivityService, type TurnActivityChange } from '../turn-activity.service';

describe('turnActivityService', () => {
  let changes: TurnActivityChange[];
  const record = (change: TurnActivityChange) => changes.push(change);

  beforeEach(() => {
    changes = [];
    mockFindLatestThread.mockReset();
    turnActivityService.events.on('change', record);
  });

  afterEach(() => {
    turnActivityService.events.off('change', record);
  });

  describe('threadFor', () => {
    const base = { agentId: 'agent-1', userId: 'user-1' };

    it('uses the thread the turn runs on', async () => {
      expect(await turnActivityService.threadFor({ ...base, mode: 'goal', threadId: 'thread-1' })).toBe('thread-1');
      expect(mockFindLatestThread).not.toHaveBeenCalled();
    });

    it('uses the latest thread for a turn without one', async () => {
      mockFindLatestThread.mockResolvedValue({ id: 'thread-latest' });

      expect(await turnActivityService.threadFor({ ...base, mode: 'webhook' })).toBe('thread-latest');
      expect(mockFindLatestThread).toHaveBeenCalledWith('agent-1', 'user-1');
    });

    it('answers null when the user has no thread', async () => {
      mockFindLatestThread.mockResolvedValue(null);

      expect(await turnActivityService.threadFor({ ...base, mode: 'heartbeat' })).toBeNull();
    });

    it('answers null when the lookup fails, so the turn still runs', async () => {
      mockFindLatestThread.mockRejectedValue(new Error('database locked'));

      expect(await turnActivityService.threadFor({ ...base, mode: 'heartbeat' })).toBeNull();
    });

    it('answers null for a subagent', async () => {
      expect(await turnActivityService.threadFor({ ...base, mode: 'subagent', threadId: 'thread-1' })).toBeNull();
    });
  });

  describe('begin', () => {
    it('emits working, then not working, under one turn id', () => {
      const end = turnActivityService.begin('thread-1');
      end();

      expect(changes).toEqual([
        { threadId: 'thread-1', turnId: expect.any(String), working: true },
        { threadId: 'thread-1', turnId: changes[0].turnId, working: false },
      ]);
    });

    it('ends a turn once', () => {
      const end = turnActivityService.begin('thread-1');
      end();
      end();

      expect(changes).toHaveLength(2);
    });

    it('lists the turns in progress', () => {
      const end = turnActivityService.begin('thread-1');
      expect(turnActivityService.activeTurns()).toEqual([changes[0]]);

      end();
      expect(turnActivityService.activeTurns()).toEqual([]);
    });

    it('keeps two overlapping turns on one thread apart', () => {
      const endFirst = turnActivityService.begin('thread-1');
      const endSecond = turnActivityService.begin('thread-1');
      endFirst();

      expect(changes[0].turnId).not.toBe(changes[1].turnId);
      expect(changes[2]).toEqual({ threadId: 'thread-1', turnId: changes[0].turnId, working: false });

      endSecond();
      expect(changes[3]).toEqual({ threadId: 'thread-1', turnId: changes[1].turnId, working: false });
    });
  });
});
