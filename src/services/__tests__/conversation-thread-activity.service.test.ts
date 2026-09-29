import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFindLatestWebThread } = vi.hoisted(() => ({ mockFindLatestWebThread: vi.fn() }));

vi.mock('../conversation.service', () => ({
  conversationService: { findLatestWebThread: mockFindLatestWebThread },
}));

vi.mock('../../logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  conversationThreadActivityService as service,
  type ThreadActivityChange,
} from '../conversation-thread-activity.service';

describe('conversationThreadActivityService', () => {
  const base = { agentId: 'agent-1', userId: 'user-1' };
  let changes: ThreadActivityChange[];
  const record = (change: ThreadActivityChange) => changes.push(change);

  beforeEach(() => {
    changes = [];
    mockFindLatestWebThread.mockReset();
    service.events.on('change', record);
  });

  afterEach(() => {
    service.events.off('change', record);
  });

  describe('Scenario: Which thread works', () => {
    it('marks the thread the request runs on', async () => {
      const activity = await service.begin({ ...base, mode: 'goal', threadId: 'thread-1' });
      activity.end();

      expect(mockFindLatestWebThread).not.toHaveBeenCalled();
      expect(changes).toEqual([
        { threadId: 'thread-1', working: true, userId: 'user-1' },
        { threadId: 'thread-1', working: false, userId: 'user-1' },
      ]);
    });

    it('marks the latest web thread for a request without one', async () => {
      mockFindLatestWebThread.mockResolvedValue({ id: 'thread-latest' });

      (await service.begin({ ...base, mode: 'webhook' })).end();

      expect(mockFindLatestWebThread).toHaveBeenCalledWith('agent-1', 'user-1');
      expect(changes[0]).toEqual({ threadId: 'thread-latest', working: true, userId: 'user-1' });
    });

    it('marks no thread when the user has none', async () => {
      mockFindLatestWebThread.mockResolvedValue(null);

      (await service.begin({ ...base, mode: 'heartbeat' })).end();

      expect(changes).toEqual([]);
    });

    it('marks no thread when the lookup fails, so the request still runs', async () => {
      mockFindLatestWebThread.mockRejectedValue(new Error('database locked'));

      (await service.begin({ ...base, mode: 'heartbeat' })).end();

      expect(changes).toEqual([]);
    });

    it('marks no thread for a subagent', async () => {
      (await service.begin({ ...base, mode: 'subagent', threadId: 'thread-1' })).end();

      expect(changes).toEqual([]);
    });
  });

  describe('Scenario: Working or not', () => {
    it('ends once', async () => {
      const activity = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      activity.end();
      activity.end();

      expect(changes).toHaveLength(2);
    });

    it('lists the working threads', async () => {
      const activity = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      expect(service.workingThreadIds()).toEqual(['thread-1']);

      activity.end();
      expect(service.workingThreadIds()).toEqual([]);
    });

    it('keeps a thread working until its last invocation ends', async () => {
      const chat = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      const cron = await service.begin({ ...base, mode: 'cron', threadId: 'thread-1' });
      chat.end();

      expect(changes).toEqual([{ threadId: 'thread-1', working: true, userId: 'user-1' }]);
      expect(service.workingThreadIds()).toEqual(['thread-1']);

      cron.end();
      expect(changes).toEqual([
        { threadId: 'thread-1', working: true, userId: 'user-1' },
        { threadId: 'thread-1', working: false, userId: 'user-1' },
      ]);
    });
  });

  describe('Scenario: Waiting for the user', () => {
    it('shows the thread idle while the invocation waits, and working again after', async () => {
      mockFindLatestWebThread.mockResolvedValue({ id: 'thread-latest' });
      const activity = await service.begin({ ...base, mode: 'heartbeat' });
      let answer!: (value: string) => void;

      const waiting = activity.idle(() => new Promise<string>((resolve) => (answer = resolve)));
      expect(service.workingThreadIds()).toEqual([]);
      answer('continued');

      expect(await waiting).toBe('continued');
      expect(service.workingThreadIds()).toEqual(['thread-latest']);
      activity.end();
      expect(service.workingThreadIds()).toEqual([]);
    });

    it('stays ended when the invocation ends during the wait', async () => {
      const activity = await service.begin({ ...base, mode: 'cron', threadId: 'thread-1' });
      let fail!: (error: Error) => void;

      const waiting = activity.idle(() => new Promise((_, reject) => (fail = reject)));
      activity.end();
      fail(new Error('aborted'));

      await expect(waiting).rejects.toThrow('aborted');
      expect(service.workingThreadIds()).toEqual([]);
    });
  });
});
