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
      const end = await service.begin({ ...base, mode: 'goal', threadId: 'thread-1' });
      end();

      expect(mockFindLatestWebThread).not.toHaveBeenCalled();
      expect(changes).toEqual([
        { threadId: 'thread-1', working: true },
        { threadId: 'thread-1', working: false },
      ]);
    });

    it('marks the latest web thread for a request without one', async () => {
      mockFindLatestWebThread.mockResolvedValue({ id: 'thread-latest' });

      (await service.begin({ ...base, mode: 'webhook' }))();

      expect(mockFindLatestWebThread).toHaveBeenCalledWith('agent-1', 'user-1');
      expect(changes[0]).toEqual({ threadId: 'thread-latest', working: true });
    });

    it('marks no thread when the user has none', async () => {
      mockFindLatestWebThread.mockResolvedValue(null);

      (await service.begin({ ...base, mode: 'heartbeat' }))();

      expect(changes).toEqual([]);
    });

    it('marks no thread when the lookup fails, so the request still runs', async () => {
      mockFindLatestWebThread.mockRejectedValue(new Error('database locked'));

      (await service.begin({ ...base, mode: 'heartbeat' }))();

      expect(changes).toEqual([]);
    });

    it('marks no thread for a subagent', async () => {
      (await service.begin({ ...base, mode: 'subagent', threadId: 'thread-1' }))();

      expect(changes).toEqual([]);
    });
  });

  describe('Scenario: Working or not', () => {
    it('ends once', async () => {
      const end = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      end();
      end();

      expect(changes).toHaveLength(2);
    });

    it('lists the working threads', async () => {
      const end = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      expect(service.workingThreadIds()).toEqual(['thread-1']);

      end();
      expect(service.workingThreadIds()).toEqual([]);
    });

    it('keeps a thread working until its last invocation ends', async () => {
      const endChat = await service.begin({ ...base, mode: 'chat', threadId: 'thread-1' });
      const endCron = await service.begin({ ...base, mode: 'cron', threadId: 'thread-1' });
      endChat();

      expect(changes).toEqual([{ threadId: 'thread-1', working: true }]);
      expect(service.workingThreadIds()).toEqual(['thread-1']);

      endCron();
      expect(changes).toEqual([
        { threadId: 'thread-1', working: true },
        { threadId: 'thread-1', working: false },
      ]);
    });
  });
});
