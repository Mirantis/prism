/**
 * Resume Replies Tests
 *
 * The boot continues each thread's interrupted reply once, for every message
 * the thread was owed: in its channel's own queue when the channel has one, at
 * once otherwise, with the delivery it was accepted under. A message a restart
 * stopped before its insert is stored from its row first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockChat, mockAcceptUserMessage, mockContinueReply, mockEndWork, mockLinkToMessage } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockLinkToMessage: vi.fn(),
  mockChat: vi.fn(),
  mockAcceptUserMessage: vi.fn(),
  mockContinueReply: vi.fn(),
  mockEndWork: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({ default: { conversationMessage: { findMany: mockFindMany } } }));
vi.mock('./conversation-engine.service', () => ({
  conversationEngineService: { chat: mockChat, acceptUserMessage: mockAcceptUserMessage },
}));
// The chat socket answers one message at a time in a queue of its own; a team chat does not.
vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    getAdapter: (name: string) => (name === 'websocket' ? { name, continueReply: mockContinueReply } : { name }),
  },
}));
vi.mock('./pending-work.service', () => ({ pendingWorkService: { end: mockEndWork } }));
vi.mock('./attachment.service', () => ({ attachmentService: { linkToMessage: mockLinkToMessage } }));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { resumeReplies } from './resume-replies';
import type { PendingWorkItem } from './pending-work.service';

const SLACK = { channel: 'slack', channelId: 'C123', channelThreadId: '1700000000.000100', channelLabel: 'ops' };

function owed(key: string, threadId: string, metadata: Record<string, unknown>, extra: object = {}): PendingWorkItem {
  return {
    key,
    payload: { threadId, agentId: 'agent-1', userId: `user-of-${threadId}`, metadata, ...extra },
    attempts: 1,
    createdAt: new Date(),
  };
}

const message = (id: string, threadId: string, content: string) => ({ id, threadId, content, role: 'USER' });

/** The stored messages, as the database answers for the ids it is asked about. */
let stored: Array<ReturnType<typeof message>> = [];

describe('resumeReplies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = [];
    mockChat.mockResolvedValue({});
    mockFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      stored.filter((row) => where.id.in.includes(row.id)),
    );
  });

  it('continues one exchange per thread, answering every message the thread was owed', async () => {
    stored = [message('m-1', 'thread-slack', 'deploy it'), message('m-2', 'thread-slack', 'and tag the release')];

    await resumeReplies([owed('m-1', 'thread-slack', SLACK), owed('m-2', 'thread-slack', SLACK)]);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledWith({
      agentId: 'agent-1',
      userId: 'user-of-thread-slack',
      threadId: 'thread-slack',
      message: 'and tag the release',
      stored: { id: 'm-2', titleSet: null },
      resumed: { messageIds: ['m-1', 'm-2'], unsaved: [], unsentAttachmentIds: [] },
      metadata: SLACK,
    });
  });

  it("puts a thread in its channel's own queue when the channel has one", async () => {
    stored = [message('m-3', 'thread-web', 'hello')];

    await resumeReplies([owed('m-3', 'thread-web', { channel: 'websocket' })]);

    expect(mockContinueReply).toHaveBeenCalledWith(message('m-3', 'thread-web', 'hello'), {
      messageIds: ['m-3'],
      unsaved: [],
      unsentAttachmentIds: [],
    });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('hands the resumed turn the tool calls history does not hold, and the files no reply delivered', async () => {
    const unsaved = [{ tool: 'share_file', input: '{}', output: 'shared', success: true, timestamp: 't' }];
    stored = [message('m-5', 'thread-slack', 'send the report')];

    await resumeReplies([owed('m-5', 'thread-slack', SLACK, { unsaved, unsentAttachmentIds: ['att-1'] })]);

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ resumed: { messageIds: ['m-5'], unsaved, unsentAttachmentIds: ['att-1'] } }),
    );
  });

  it('stores a message a restart stopped before its insert, then answers it', async () => {
    mockAcceptUserMessage.mockImplementation(async (_input: unknown, threadId: string, id: string) => {
      stored.push(message(id, threadId, 'deploy it'));
    });

    await resumeReplies([owed('m-6', 'thread-slack', SLACK, { message: { message: 'deploy it' } })]);

    expect(mockAcceptUserMessage).toHaveBeenCalledWith(
      { agentId: 'agent-1', userId: 'user-of-thread-slack', metadata: SLACK, message: 'deploy it' },
      'thread-slack',
      'm-6',
    );
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ stored: { id: 'm-6', titleSet: null }, resumed: { messageIds: ['m-6'], unsaved: [], unsentAttachmentIds: [] } }),
    );
    expect(mockEndWork).toHaveBeenCalledWith('chat', []);
  });

  it('lists each owed file once, also when two rows both hold it', async () => {
    stored = [message('m-8', 'thread-slack', 'send it'), message('m-9', 'thread-slack', 'and the log')];

    await resumeReplies([
      owed('m-8', 'thread-slack', SLACK, { unsentAttachmentIds: ['att-1'] }),
      owed('m-9', 'thread-slack', SLACK, { unsentAttachmentIds: ['att-1', 'att-2'] }),
    ]);

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ resumed: { messageIds: ['m-8', 'm-9'], unsaved: [], unsentAttachmentIds: ['att-1', 'att-2'] } }),
    );
  });

  it('links the uploads of a message a restart stored before their link', async () => {
    stored = [message('m-7', 'thread-slack', 'see the log')];

    await resumeReplies([owed('m-7', 'thread-slack', SLACK, { message: { message: 'see the log', attachmentIds: ['att-1'] } })]);

    expect(mockLinkToMessage).toHaveBeenCalledWith(['att-1'], 'm-7', 'thread-slack');
    expect(mockAcceptUserMessage).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ stored: { id: 'm-7', titleSet: null } }));
  });

  it('owes nothing for a message whose thread is gone', async () => {
    mockAcceptUserMessage.mockRejectedValue(new Error('Foreign key constraint violated'));

    await resumeReplies([owed('m-deleted', 'thread-gone', SLACK, { message: { message: 'deploy it' } })]);

    expect(mockEndWork).toHaveBeenCalledWith('chat', ['m-deleted']);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
