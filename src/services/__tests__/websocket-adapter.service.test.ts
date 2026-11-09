import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHasSeveralSenders, mockFindThread } = vi.hoisted(() => ({
  mockHasSeveralSenders: vi.fn(),
  mockFindThread: vi.fn(),
}));

vi.mock('../../lib/prisma', () => {
  const prisma = { conversationThread: { findUnique: mockFindThread } };
  return { prisma, default: prisma };
});

vi.mock('../conversation.service', () => ({ conversationService: { hasSeveralSenders: mockHasSeveralSenders } }));
vi.mock('../inbound-message.service', () => ({ inboundMessageService: { resume: vi.fn() } }));
vi.mock('../event-stream.service', () => ({ eventStreamService: { publish: vi.fn() } }));

import { messageEventPayload, webSocketAdapterService } from '../websocket-adapter.service';
import { WEB_CHAT_LABEL } from '../web-chat-label';

describe('webSocketAdapterService.threadDestination', () => {
  beforeEach(() => {
    mockFindThread.mockResolvedValue({ externalThreadId: null });
  });

  it('gives a continuation of a web chat that two people wrote in the web chat label', async () => {
    mockHasSeveralSenders.mockResolvedValue(true);

    await expect(webSocketAdapterService.threadDestination('thread-1')).resolves.toEqual({
      channelLabel: WEB_CHAT_LABEL,
    });
    expect(mockHasSeveralSenders).toHaveBeenCalledWith('thread-1');
  });

  it('gives a one-person web chat no label', async () => {
    mockHasSeveralSenders.mockResolvedValue(false);

    await expect(webSocketAdapterService.threadDestination('thread-1')).resolves.toEqual({ channelLabel: undefined });
  });

  it('gives a thread that a channel keeps its own id for no label, whoever wrote there', async () => {
    mockFindThread.mockResolvedValue({ externalThreadId: '1700000000.000100' });
    mockHasSeveralSenders.mockResolvedValue(true);

    await expect(webSocketAdapterService.threadDestination('thread-1')).resolves.toEqual({ channelLabel: undefined });
    expect(mockHasSeveralSenders).not.toHaveBeenCalled();
  });
});

describe('messageEventPayload', () => {
  const message = {
    id: 'm-1', threadId: 'thread-1', role: 'AGENT', content: 'Checking the pods…', triggeredBy: 'USER_INPUT',
    triggerName: null, toolCalls: null, blocks: null, senderExternalId: null, senderName: null,
    externalMessageId: null, isCompacted: false, internalStep: false, step: true,
    createdAt: new Date('2026-11-09T10:00:00.000Z'),
  } as const;

  it('says whether the message is a step of a verbose turn', () => {
    expect(messageEventPayload(message).step).toBe(true);
    expect(messageEventPayload({ ...message, step: false }).step).toBe(false);
  });
});
