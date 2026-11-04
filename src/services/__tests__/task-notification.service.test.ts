import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  writableThreadId: vi.fn(),
  threadContext: vi.fn(),
  acceptUserMessage: vi.fn(),
  chat: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({ default: { conversationMessage: { findUnique: mocks.findUnique } } }));
vi.mock('../conversation.service', () => ({ conversationService: { writableThreadId: mocks.writableThreadId } }));
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: { threadContext: mocks.threadContext } }));
vi.mock('../conversation-engine.service', () => ({
  conversationEngineService: { acceptUserMessage: mocks.acceptUserMessage, chat: mocks.chat },
}));
vi.mock('../../lib/telemetry', () => ({ trackEvent: mocks.trackEvent }));

import { taskNotificationService } from '../task-notification.service';

const target = { threadId: 'thread-1', agentId: 'agent-1', userId: 'user-1', originChannel: 'slack', originChannelId: 'C1' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('taskNotificationService.deliver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.writableThreadId.mockImplementation(async (id: string) => id);
    mocks.threadContext.mockResolvedValue({
      channel: 'slack',
      threadId: 'thread-1',
      channelId: 'C1',
      channelThreadId: '1700000000.000100',
      channelLabel: '#platform',
    });
    mocks.acceptUserMessage.mockResolvedValue({ message: { id: 'task-1' }, titleSet: null });
    mocks.chat.mockResolvedValue({ steered: false });
  });

  it('stores the report under the task id in its conversation, then answers it there', async () => {
    await taskNotificationService.deliver(target, 'task-1', 'REPORT');

    const input = {
      agentId: 'agent-1',
      userId: 'user-1',
      message: 'REPORT',
      taskNotification: { taskId: 'task-1' },
      metadata: { channel: 'slack', channelId: 'C1', channelThreadId: '1700000000.000100', channelLabel: '#platform' },
    };
    expect(mocks.threadContext).toHaveBeenCalledWith('thread-1', 'slack', 'C1');
    expect(mocks.acceptUserMessage).toHaveBeenCalledWith(input, 'thread-1', 'task-1');
    expect(mocks.chat).toHaveBeenCalledWith({ ...input, threadId: 'thread-1', stored: { id: 'task-1', titleSet: null } });
    expect(mocks.acceptUserMessage.mock.invocationCallOrder[0]).toBeLessThan(mocks.chat.mock.invocationCallOrder[0]);
  });

  it('stores a report already stored once only once', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'task-1' });

    await taskNotificationService.deliver(target, 'task-1', 'REPORT');

    expect(mocks.acceptUserMessage).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('reports whether a running turn took the report or a turn of its own answered it', async () => {
    mocks.chat.mockResolvedValueOnce({ steered: true });
    await taskNotificationService.deliver(target, 'task-1', 'REPORT');
    await flush();
    mocks.chat.mockRejectedValueOnce(new Error('model unavailable'));
    await taskNotificationService.deliver(target, 'task-2', 'REPORT');
    await flush();

    expect(mocks.trackEvent).toHaveBeenNthCalledWith(1, 'task notification delivered', 'user-1', {
      'agent.id': 'agent-1',
      'thread.id': 'thread-1',
      'task.id': 'task-1',
      'notification.delivery': 'steered',
    });
    expect(mocks.trackEvent).toHaveBeenNthCalledWith(2, 'task notification delivered', 'user-1', expect.objectContaining({
      'task.id': 'task-2',
      'notification.delivery': 'failed',
    }));
  });

  it('fails without starting a turn when the report cannot be stored', async () => {
    mocks.acceptUserMessage.mockRejectedValue(new Error('database is locked'));

    await expect(taskNotificationService.deliver(target, 'task-1', 'REPORT')).rejects.toThrow('database is locked');
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
