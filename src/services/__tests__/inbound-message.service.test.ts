import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma, mockEngine, mockConfig } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: { findUnique: vi.fn() },
    conversationMessage: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
  mockEngine: {
    acceptUserMessage: vi.fn(),
    chat: vi.fn(),
    cancel: vi.fn(),
    events: null as unknown as import('node:events').EventEmitter,
  },
  mockConfig: { agentId: 'agent-1' as string | undefined, ownerUserId: 'owner-1' },
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../conversation-engine.service', async () => {
  const { EventEmitter } = await import('node:events');
  mockEngine.events = new EventEmitter();
  return { conversationEngineService: mockEngine };
});
vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../conversation.service', () => ({ conversationService: {} }));
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: { showInConversation: vi.fn() } }));

import { inboundMessageService } from '../inbound-message.service';
import { eventStreamService } from '../event-stream.service';
import { conversationThreadActivityService } from '../conversation-thread-activity.service';
import type { ChatTurnEnd } from '../conversation-engine.service';

const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';

const inbound = (id: string, threadId = THREAD_A, content = 'hello') => ({
  id,
  threadId,
  content,
  attachmentIds: [],
  sender: { id: 'user-ada-1', name: 'Ada Lovelace' },
});

const row = (id: string, threadId = THREAD_A, content = 'hello') => ({
  id,
  threadId,
  role: 'USER',
  content,
  createdAt: new Date('2026-09-27T10:00:00.000Z'),
});

type ChatCall = { threadId: string; message: string; steerOnly?: boolean };

/**
 * An exchange as the engine runs one: it says how it ended, then resolves. An offer to
 * a running turn that nobody takes runs nothing.
 */
function exchange(ended: Partial<ChatTurnEnd> = {}) {
  return async ({ threadId, steerOnly }: ChatCall) => {
    if (!steerOnly) mockEngine.events.emit('turnEnded', { threadId, cancelled: false, ...ended });
    return { steered: false };
  };
}

/** A turn the test ends when it chooses, as a real one ends when the model is done. */
function heldTurn(ended: Partial<ChatTurnEnd> = {}) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { finish, run: (input: ChatCall) => done.then(() => exchange(ended)(input)) };
}

function turnEvents() {
  const events: Array<Record<string, unknown>> = [];
  const stop = eventStreamService.subscribe((entry) => {
    if (entry.event.type === 'turn') events.push(entry.event.payload as unknown as Record<string, unknown>);
  });
  return { events, stop };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InboundMessageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inboundMessageService.resetForTests();
    eventStreamService.resetForTests();
    mockConfig.agentId = 'agent-1';
    mockPrisma.conversationThread.findUnique.mockResolvedValue({
      agentId: 'agent-1',
      userId: 'owner-1',
      threadSource: 'DATABASE',
    });
    mockPrisma.conversationMessage.findUnique.mockResolvedValue(null);
    mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);
    mockEngine.acceptUserMessage.mockImplementation(async (_input, threadId, id) => ({
      message: row(id, threadId),
      titleSet: null,
    }));
    mockEngine.chat.mockImplementation(exchange());
    mockEngine.cancel.mockReturnValue(false);
  });

  describe('Scenario: storing first', () => {
    it('stores the message under the client id before its turn runs, then runs it', async () => {
      const acceptance = await inboundMessageService.accept(inbound('m-1'));

      expect(acceptance).toMatchObject({ queued: false, duplicate: false });
      expect(mockEngine.acceptUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'hello', metadata: {
          channel: 'websocket',
          senderExternalId: 'user-ada-1',
          senderName: 'Ada Lovelace',
        } }),
        THREAD_A,
        'm-1',
      );
      await settle();
      expect(mockEngine.chat).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: THREAD_A, stored: { titleSet: null } }),
      );
      expect(mockEngine.acceptUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockEngine.chat.mock.invocationCallOrder[0]!,
      );
    });

    it('refuses a conversation that is not one of this agent’s web threads', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-1',
        userId: 'owner-1',
        threadSource: 'SLACK',
      });
      await expect(inboundMessageService.accept(inbound('m-1'))).rejects.toMatchObject({ code: 'unknown_thread' });
      expect(mockEngine.acceptUserMessage).not.toHaveBeenCalled();
    });

    it('says the agent is unavailable while it is still starting', async () => {
      mockConfig.agentId = undefined;
      await expect(inboundMessageService.accept(inbound('m-1'))).rejects.toMatchObject({ code: 'unavailable' });
    });
  });

  describe('Scenario: sending twice', () => {
    it('stores two copies of one send once', async () => {
      const [first, second] = await Promise.all([
        inboundMessageService.accept(inbound('m-1')),
        inboundMessageService.accept(inbound('m-1')),
      ]);
      expect(mockEngine.acceptUserMessage).toHaveBeenCalledTimes(1);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
    });

    it('confirms a resend of a stored, answered message and answers it no second time', async () => {
      mockPrisma.conversationMessage.findUnique.mockResolvedValue(row('m-1'));
      mockPrisma.conversationMessage.findFirst.mockResolvedValue({ id: 'reply' });

      const acceptance = await inboundMessageService.accept(inbound('m-1'));
      await settle();

      expect(acceptance.duplicate).toBe(true);
      expect(mockEngine.acceptUserMessage).not.toHaveBeenCalled();
      expect(mockEngine.chat).not.toHaveBeenCalled();
    });

    it('answers a stored message that never got its turn, when it is sent again', async () => {
      // The process stopped between storing the message and running its turn.
      mockPrisma.conversationMessage.findUnique.mockResolvedValue(row('m-1'));
      mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

      const acceptance = await inboundMessageService.accept(inbound('m-1'));
      await settle();

      expect(acceptance.duplicate).toBe(true);
      expect(mockEngine.acceptUserMessage).not.toHaveBeenCalled();
      expect(mockEngine.chat).toHaveBeenCalledTimes(1);
    });

    it('does not start a second turn for a resend while the first is still running', async () => {
      const turn = heldTurn();
      mockEngine.chat.mockImplementationOnce(turn.run);
      await inboundMessageService.accept(inbound('m-1'));
      await settle();

      mockPrisma.conversationMessage.findUnique.mockResolvedValue(row('m-1'));
      await inboundMessageService.accept(inbound('m-1'));
      await settle();

      expect(mockEngine.chat).toHaveBeenCalledTimes(1);
      turn.finish();
    });

    it('refuses an id that belongs to another conversation', async () => {
      mockPrisma.conversationMessage.findUnique.mockResolvedValue(row('m-1', THREAD_B));
      await expect(inboundMessageService.accept(inbound('m-1'))).rejects.toMatchObject({ code: 'id_conflict' });
    });

    it("refuses an id that belongs to the agent's reply", async () => {
      mockPrisma.conversationMessage.findUnique.mockResolvedValue({ ...row('m-1'), role: 'AGENT' });
      await expect(inboundMessageService.accept(inbound('m-1'))).rejects.toMatchObject({ code: 'id_conflict' });
    });

    it('stores a copy sent while the first failed to store', async () => {
      mockEngine.acceptUserMessage.mockRejectedValueOnce(new Error('disk full'));
      const [first, second] = await Promise.allSettled([
        inboundMessageService.accept(inbound('m-1')),
        inboundMessageService.accept(inbound('m-1')),
      ]);
      expect(first.status).toBe('rejected');
      expect(second).toMatchObject({ status: 'fulfilled', value: { duplicate: false } });
      expect(mockEngine.acceptUserMessage).toHaveBeenCalledTimes(2);
    });

    it('checks a copy sent while the first is still being stored against the stored row', async () => {
      const [first, second] = await Promise.allSettled([
        inboundMessageService.accept(inbound('m-1', THREAD_A)),
        inboundMessageService.accept(inbound('m-1', THREAD_B)),
      ]);
      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({ status: 'rejected', reason: { code: 'id_conflict' } });
      expect(mockEngine.acceptUserMessage).toHaveBeenCalledTimes(1);
    });

    it('treats an insert that lost a race for the id as the resend it is', async () => {
      mockEngine.acceptUserMessage.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
      );
      mockPrisma.conversationMessage.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('m-1'));
      mockPrisma.conversationMessage.findFirst.mockResolvedValue({ id: 'reply' });

      expect((await inboundMessageService.accept(inbound('m-1'))).duplicate).toBe(true);
    });
  });

  describe('Scenario: one turn at a time', () => {
    it('queues a message for another conversation, tells everyone, and answers it next', async () => {
      const { events, stop } = turnEvents();
      const first = heldTurn();
      mockEngine.chat.mockImplementationOnce(first.run);

      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();
      const second = await inboundMessageService.accept(inbound('m-2', THREAD_B));

      expect(second.queued).toBe(true);
      expect(inboundMessageService.turns()).toEqual(
        expect.arrayContaining([
          { threadId: THREAD_A, state: 'running' },
          { threadId: THREAD_B, state: 'queued' },
        ]),
      );
      expect(events).toContainEqual({ threadId: THREAD_B, state: 'queued' });

      first.finish();
      await vi.waitFor(() =>
        expect(mockEngine.chat).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: THREAD_B })),
      );
      await settle();
      expect(events).toContainEqual({ threadId: THREAD_A, state: 'idle', outcome: 'completed' });
      expect(inboundMessageService.turns()).toEqual([]);
      stop();
    });

    it('hands a message to the running turn of its own conversation', async () => {
      const first = heldTurn();
      mockEngine.chat.mockImplementationOnce(first.run).mockResolvedValueOnce({ steered: true });

      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();
      const followUp = await inboundMessageService.accept(inbound('m-2', THREAD_A));

      expect(followUp.queued).toBe(false);
      expect(mockEngine.chat).toHaveBeenLastCalledWith(expect.objectContaining({ steerOnly: true }));
      first.finish();
    });

    it('answers the queue with no client connected at all', async () => {
      // Nothing here involves a socket: the queue holds stored rows and drains by itself.
      const first = heldTurn();
      mockEngine.chat.mockImplementationOnce(first.run);
      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();
      await inboundMessageService.accept(inbound('m-2', THREAD_B));

      first.finish();
      await vi.waitFor(() => expect(mockEngine.chat).toHaveBeenCalledTimes(3));
    });

    it('reports a turn that failed, with what went wrong', async () => {
      const { events, stop } = turnEvents();
      mockEngine.chat.mockRejectedValueOnce(new Error('The model is unavailable.'));

      await inboundMessageService.accept(inbound('m-1'));
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          threadId: THREAD_A,
          state: 'idle',
          outcome: 'failed',
          // The exception stays in the log; clients get a sentence.
          error: 'The agent could not answer. Try again.',
        }),
      );
      stop();
    });

    it('reports a turn whose reply is an error report as failed', async () => {
      const { events, stop } = turnEvents();
      mockEngine.chat.mockImplementationOnce(exchange({ error: { type: 'generic', detail: 'Authentication failed' } }));

      await inboundMessageService.accept(inbound('m-1'));
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          threadId: THREAD_A,
          state: 'idle',
          outcome: 'failed',
          error: 'The agent could not answer. Try again.',
        }),
      );
      stop();
    });

    it('reports a turn stopped by the spending limit without asking to try again', async () => {
      const { events, stop } = turnEvents();
      mockEngine.chat.mockImplementationOnce(exchange({ error: { type: 'budget_exceeded', detail: null } }));

      await inboundMessageService.accept(inbound('m-1'));
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          threadId: THREAD_A,
          state: 'idle',
          outcome: 'failed',
          error: 'The AI spending limit is reached.',
        }),
      );
      stop();
    });

    it('reports how the last of two queued turns on one conversation ended', async () => {
      const { events, stop } = turnEvents();
      const first = heldTurn();
      mockEngine.chat.mockImplementation((input: ChatCall) => {
        if (input.threadId === THREAD_A) return first.run(input);
        return exchange(input.message === 'second' ? { error: { type: 'generic' } } : {})(input);
      });

      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();
      await inboundMessageService.accept(inbound('m-2', THREAD_B, 'first'));
      await inboundMessageService.accept(inbound('m-3', THREAD_B, 'second'));
      first.finish();

      await vi.waitFor(() =>
        expect(events.filter((event) => event.threadId === THREAD_B).at(-1)).toEqual({
          threadId: THREAD_B,
          state: 'idle',
          outcome: 'failed',
          error: 'The agent could not answer. Try again.',
        }),
      );
      stop();
    });
  });

  describe('Scenario: a goal holds the conversation busy between turns', () => {
    it('reports how the last turn ended when the goal ends', async () => {
      const { events, stop } = turnEvents();
      const endGoal = conversationThreadActivityService.beginThread(THREAD_A, 'owner-1');
      mockEngine.chat
        .mockImplementationOnce(exchange())
        .mockImplementationOnce(exchange({ error: { type: 'generic', detail: 'Model unavailable' } }));

      await inboundMessageService.accept(inbound('m-1'));
      await settle();
      await inboundMessageService.accept(inbound('m-2'));
      await settle();
      endGoal();

      expect(events.at(-1)).toEqual({
        threadId: THREAD_A,
        state: 'idle',
        outcome: 'failed',
        error: 'The agent could not answer. Try again.',
      });
      stop();
    });
  });

  describe('Scenario: cancel', () => {
    it('stops the conversation’s turn and reports it cancelled', async () => {
      const { events, stop } = turnEvents();
      const turn = heldTurn({ cancelled: true });
      mockEngine.chat.mockImplementationOnce(turn.run);
      mockEngine.cancel.mockReturnValue(true);

      await inboundMessageService.accept(inbound('m-1'));
      await settle();
      expect(await inboundMessageService.cancel(THREAD_A)).toBe(true);
      expect(mockEngine.cancel).toHaveBeenCalledWith(THREAD_A);

      turn.finish();
      await vi.waitFor(() =>
        expect(events).toContainEqual({ threadId: THREAD_A, state: 'idle', outcome: 'cancelled' }),
      );
      stop();
    });

    it('drops only that conversation’s waiting messages', async () => {
      const first = heldTurn();
      mockEngine.chat.mockImplementationOnce(first.run);
      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();
      await inboundMessageService.accept(inbound('m-2', THREAD_B));

      expect(await inboundMessageService.cancel(THREAD_B)).toBe(true);
      expect(inboundMessageService.turns()).toEqual([{ threadId: THREAD_A, state: 'running' }]);

      first.finish();
      await settle();
      await settle();
      // Offered to the running turn once, never run as a turn of its own.
      const turnsForB = mockEngine.chat.mock.calls.filter(
        ([input]) => input.threadId === THREAD_B && !input.steerOnly,
      );
      expect(turnsForB).toHaveLength(0);
    });
  });

  describe('Scenario: scheduling fails after the message is stored', () => {
    it('confirms the message and queues it rather than refusing it', async () => {
      const first = heldTurn();
      mockEngine.chat.mockImplementationOnce(first.run).mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      await inboundMessageService.accept(inbound('m-1', THREAD_A));
      await settle();

      const second = await inboundMessageService.accept(inbound('m-2', THREAD_B));
      expect(second).toMatchObject({ queued: true, duplicate: false });

      first.finish();
      await vi.waitFor(() =>
        expect(mockEngine.chat).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: THREAD_B })),
      );
    });
  });

  describe('Scenario: a web conversation stored under another user id', () => {
    beforeEach(() => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-1',
        userId: 'agent-record-user',
        threadSource: 'DATABASE',
      });
    });

    it('accepts a send to it', async () => {
      const acceptance = await inboundMessageService.accept(inbound('m-1'));
      expect(acceptance).toMatchObject({ queued: false, duplicate: false });
      expect(mockEngine.acceptUserMessage).toHaveBeenCalledWith(expect.anything(), THREAD_A, 'm-1');
    });

    it('cancels its running turn', async () => {
      mockEngine.cancel.mockReturnValue(true);
      expect(await inboundMessageService.cancel(THREAD_A)).toBe(true);
      expect(mockEngine.cancel).toHaveBeenCalledWith(THREAD_A);
    });

    it('shows its turn state', () => {
      const { events, stop } = turnEvents();
      const end = conversationThreadActivityService.beginThread(THREAD_A, 'agent-record-user');
      expect(inboundMessageService.turns()).toEqual([{ threadId: THREAD_A, state: 'running' }]);
      end();
      expect(events).toEqual([
        { threadId: THREAD_A, state: 'running' },
        { threadId: THREAD_A, state: 'idle', outcome: 'completed' },
      ]);
      stop();
    });
  });

  describe('Scenario: a conversation that is not a web thread of this agent', () => {
    it('refuses to cancel a Slack thread', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-1',
        userId: 'owner-1',
        threadSource: 'SLACK',
      });
      await expect(inboundMessageService.cancel('slack-thread')).rejects.toMatchObject({ code: 'unknown_thread' });
      expect(mockEngine.cancel).not.toHaveBeenCalled();
    });

    it('refuses a send to another agent’s thread', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-2',
        userId: 'owner-1',
        threadSource: 'DATABASE',
      });
      await expect(inboundMessageService.accept(inbound('m-1'))).rejects.toMatchObject({ code: 'unknown_thread' });
      expect(mockEngine.acceptUserMessage).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: work the runtime started itself', () => {
    it('shows a conversation working while any turn runs on it', async () => {
      const { events, stop } = turnEvents();
      const end = conversationThreadActivityService.beginThread(THREAD_A, 'owner-1');
      expect(inboundMessageService.turns()).toEqual([{ threadId: THREAD_A, state: 'running' }]);
      end();
      expect(events).toEqual([
        { threadId: THREAD_A, state: 'running' },
        { threadId: THREAD_A, state: 'idle', outcome: 'completed' },
      ]);
      stop();
    });

    it('reports an exchange it did not start, such as a skill run, as failed when its reply is an error', () => {
      const { events, stop } = turnEvents();
      const end = conversationThreadActivityService.beginThread(THREAD_A, 'owner-1');
      mockEngine.events.emit('turnEnded', { threadId: THREAD_A, cancelled: false, error: { type: 'generic' } });
      end();
      expect(events.at(-1)).toEqual({
        threadId: THREAD_A,
        state: 'idle',
        outcome: 'failed',
        error: 'The agent could not answer. Try again.',
      });
      stop();
    });
  });
});
