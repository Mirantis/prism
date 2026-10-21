/**
 * Conversation Service Tests
 *
 * Tests for ConversationService covering:
 * - Thread listing
 * - Thread retrieval (getThread)
 * - Message persistence
 * - Get or create active thread
 * - Conversation compaction
 * - Provider resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    conversationMessage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    messageAttachment: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  default: mockPrisma,
}));

const { runtimeState } = vi.hoisted(() => ({ runtimeState: new Map<string, string>() }));

vi.mock('./runtime-state.service', () => ({
  SINGLE_THREAD: 'singleThread',
  runtimeStateService: {
    get: async (key: string) => runtimeState.get(key) ?? null,
    set: async (key: string, value: string) => void runtimeState.set(key, value),
    delete: async (key: string) => void runtimeState.delete(key),
  },
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../logger', () => ({
  logger: mockLogger,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { conversationService } from './conversation.service';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestThread(overrides?: Record<string, unknown>) {
  return {
    id: `thread-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-123',
    agentId: 'agent-123',
    title: null,
    externalThreadId: null,
    externalChannelId: null,
    threadSource: 'DATABASE',
    compactionSummary: null,
    compactedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ConversationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // addMessage reads `.count` from this; default to "nothing updated" so
    // tests that don't care about title-setting don't trip over it.
    mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });
  });

  // ==========================================================================
  // Thread listing
  // ==========================================================================

  describe('listThreads', () => {
    it('should return user conversation threads', async () => {
      const threads = [
        createTestThread({ title: 'Debugging session' }),
        createTestThread({ title: 'Security review' }),
      ];
      mockPrisma.conversationThread.findMany.mockResolvedValue(threads);

      const result = await conversationService.listThreads('user-123', 'agent-123', {});

      expect(result).toHaveLength(2);
      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('should respect custom limit', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { limit: 5 });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
    });

    it('should default to 20 when no limit provided', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123');

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('DATABASE filter also requires externalThreadId: null (excludes top-level DM threads from Recents/resume)', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { threadSource: 'DATABASE' });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: {
          agentId: 'agent-123',
          userId: 'user-123',
          threadSource: 'DATABASE',
          externalThreadId: null,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it("another source's filter is untouched (no externalThreadId constraint)", async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { threadSource: 'SLACK' });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123', threadSource: 'SLACK' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });
  });

  // ==========================================================================
  // Lightweight ownership check
  // ==========================================================================

  describe('getOwnedThreadId', () => {
    it('returns the id (selecting only id, no messages) when owned', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue({ id: 'thread-x' });

      const id = await conversationService.getOwnedThreadId('user-123', 'agent-123', 'thread-x');

      expect(id).toBe('thread-x');
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { id: 'thread-x', agentId: 'agent-123', userId: 'user-123' },
        select: { id: true },
      });
    });

    it('returns null when the thread is missing / not owned', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);

      expect(
        await conversationService.getOwnedThreadId('user-123', 'agent-123', 'nope'),
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Get or create latest thread
  // ==========================================================================

  describe('getOrCreateLatestThread', () => {
    it('should return the existing latest web thread', async () => {
      const existingThread = createTestThread();
      mockPrisma.conversationThread.findFirst.mockResolvedValue(existingThread);

      const result = await conversationService.getOrCreateLatestThread('agent-123', 'user-123');

      expect(result.id).toBe(existingThread.id);
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123', externalThreadId: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.conversationThread.create).not.toHaveBeenCalled();
    });

    it('should create new thread if none exists', async () => {
      const newThread = createTestThread();
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      mockPrisma.conversationThread.create.mockResolvedValue(newThread);

      await conversationService.getOrCreateLatestThread('agent-123', 'user-123');

      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123' },
      });
    });
  });

  // ==========================================================================
  // Get or create a fresh thread (web "new conversation" button)
  // ==========================================================================

  // Reuse is gated on `conversationMessage.count` — the thread row itself
  // carries no message count, so that mock is what decides these cases.
  describe('getOrCreateFreshThread', () => {
    it('reuses the newest thread when it is untouched', async () => {
      const untouched = createTestThread({ id: 'thread-empty', workspaceRoot: null });
      mockPrisma.conversationThread.findFirst.mockResolvedValue(untouched);
      mockPrisma.conversationMessage.count.mockResolvedValue(0);

      const result = await conversationService.getOrCreateFreshThread('agent-123', 'user-123');

      expect(result.id).toBe('thread-empty');
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: {
          agentId: 'agent-123',
          userId: 'user-123',
          externalThreadId: null,
          threadSource: 'DATABASE',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.conversationMessage.count).toHaveBeenCalledWith({
        where: { threadId: 'thread-empty' },
      });
      expect(mockPrisma.conversationThread.create).not.toHaveBeenCalled();
    });

    it('creates a new thread when the newest one has messages', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(
        createTestThread({ workspaceRoot: null }),
      );
      mockPrisma.conversationMessage.count.mockResolvedValue(3);
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-new' }),
      );

      const result = await conversationService.getOrCreateFreshThread('agent-123', 'user-123');

      expect(result.id).toBe('thread-new');
      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123' },
      });
    });

    it('never reuses a workspace-rooted thread, even an empty one', async () => {
      // The CLI creates a workspace-rooted thread on every launch; handing that
      // session's thread to the web would make them share it. The guard
      // short-circuits, so the count is never even queried.
      mockPrisma.conversationThread.findFirst.mockResolvedValue(
        createTestThread({ workspaceRoot: '/home/me/project' }),
      );
      mockPrisma.conversationMessage.count.mockResolvedValue(0);
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-new' }),
      );

      const result = await conversationService.getOrCreateFreshThread('agent-123', 'user-123');

      expect(result.id).toBe('thread-new');
      expect(mockPrisma.conversationMessage.count).not.toHaveBeenCalled();
    });

    it('creates a new thread when none exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-new' }),
      );

      const result = await conversationService.getOrCreateFreshThread('agent-123', 'user-123');

      expect(result.id).toBe('thread-new');
    });
  });

  // ==========================================================================
  // Start a new thread (CLI open / session reset)
  // ==========================================================================

  describe('startNewThread', () => {
    it('creates a fresh thread without archiving or reusing', async () => {
      const newThread = createTestThread({ id: 'thread-new' });
      mockPrisma.conversationThread.create.mockResolvedValue(newThread);

      const result = await conversationService.startNewThread('agent-123', 'user-123');

      // No status to flip, no lookup — just create. The newest thread is the latest.
      expect(mockPrisma.conversationThread.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.conversationThread.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123' },
      });
      expect(result.id).toBe('thread-new');
    });

    it('emits "thread created" telemetry for the new thread', async () => {
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-fresh' }),
      );

      await conversationService.startNewThread('agent-123', 'user-123');

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-fresh',
        'thread.source': 'database',
      });
    });

    it('persists workspaceRoot when provided', async () => {
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread());

      await conversationService.startNewThread('agent-123', 'user-123', {
        workspaceRoot: '/home/me/project',
      });

      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: {
          agentId: 'agent-123',
          userId: 'user-123',
          workspaceRoot: '/home/me/project',
        },
      });
    });

    it('omits workspaceRoot when empty / whitespace-only', async () => {
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread());

      await conversationService.startNewThread('agent-123', 'user-123', {
        workspaceRoot: '   ',
      });

      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123' },
      });
    });
  });

  // ==========================================================================
  // getThreadWorkspaceRoot
  // ==========================================================================

  describe('getThreadWorkspaceRoot', () => {
    it('returns the persisted workspace root', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        workspaceRoot: '/home/me/project',
      });

      const root = await conversationService.getThreadWorkspaceRoot('thread-123');

      expect(root).toBe('/home/me/project');
      expect(mockPrisma.conversationThread.findUnique).toHaveBeenCalledWith({
        where: { id: 'thread-123' },
        select: { workspaceRoot: true },
      });
    });

    it('returns null when unset or thread missing', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ workspaceRoot: null });
      expect(await conversationService.getThreadWorkspaceRoot('t1')).toBeNull();

      mockPrisma.conversationThread.findUnique.mockResolvedValue(null);
      expect(await conversationService.getThreadWorkspaceRoot('t2')).toBeNull();
    });
  });

  // ==========================================================================
  // Message persistence
  // ==========================================================================

  describe('addMessage', () => {
    it('should create user message in thread', async () => {
      const threadId = 'thread-123';
      const messageInput = {
        content: 'What pods are running?',
        role: 'USER' as const,
        triggeredBy: 'USER_INPUT' as const,
      };

      mockPrisma.conversationMessage.create.mockImplementation(async ({ data }: any) => ({
        id: 'msg-new',
        ...data,
        isCompacted: false,
        createdAt: new Date(),
      }));

      const result = await conversationService.addMessage(threadId, messageInput);

      expect(result.message.role).toBe('USER');
      expect(result.message.content).toBe('What pods are running?');
      expect(mockPrisma.conversationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          threadId,
          role: 'USER',
          content: 'What pods are running?',
          triggeredBy: 'USER_INPUT',
        }),
      });
    });

    it('names the thread after the first user message and reports titleSet', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'm1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());
      // The guarded update matched (title was null) → one row changed.
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });

      const result = await conversationService.addMessage('thread-1', {
        content: 'migrate the authentication layer now please',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      });

      // `title: null` in the where clause makes this fire only for the first
      // user message — later messages are a no-op (title already set).
      expect(mockPrisma.conversationThread.updateMany).toHaveBeenCalledWith({
        where: { id: 'thread-1', title: null },
        data: { title: 'migrate the authentic...' },
      });
      expect(result.titleSet).toBe('migrate the authentic...');
    });

    it('reports titleSet=null when the thread is already titled', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'm1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());
      // Guard didn't match (title already set) → no rows changed.
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });

      const result = await conversationService.addMessage('thread-1', {
        content: 'a second message',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      });

      expect(result.titleSet).toBeNull();
    });

    it('does not set a title (titleSet=null) for an AGENT message', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'm1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());

      const result = await conversationService.addMessage('thread-1', {
        content: 'here is the answer',
        role: 'AGENT',
        triggeredBy: 'USER_INPUT',
      });

      expect(mockPrisma.conversationThread.updateMany).not.toHaveBeenCalled();
      expect(result.titleSet).toBeNull();
    });

    it('does not set a title for a file-only (empty content) user message', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'm1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());

      const result = await conversationService.addMessage('thread-1', {
        content: '   ',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      });

      expect(mockPrisma.conversationThread.updateMany).not.toHaveBeenCalled();
      expect(result.titleSet).toBeNull();
    });

    // Internal rows are written for model context, not spoken by the user. A first
    // message carrying only a file leaves the title unset, and a turn's recalled
    // memories would otherwise be the next USER row with text — naming the thread
    // "Context: <recalled-memo…".
    it('does not set a title from an internal-step user row', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'm1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());

      const result = await conversationService.addMessage('thread-1', {
        content: 'Context:\n<recalled-memories>\n- User likes chocolate.\n</recalled-memories>',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
        internalStep: true,
      });

      expect(mockPrisma.conversationThread.updateMany).not.toHaveBeenCalled();
      expect(result.titleSet).toBeNull();
    });
  });

  // ==========================================================================
  // Provider resolution
  // ==========================================================================

  describe('getRecentMessages', () => {
    it('should use DatabaseThreadProvider for DATABASE threads and hide internal steps', async () => {
      const threadId = 'thread-db';
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE' });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getRecentMessages(threadId, 10);

      // CLIENT (CLI /messages) view: concise internal steps are filtered out,
      // but compacted rows stay visible — compaction only changes the model view.
      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId, internalStep: false },
        })
      );
    });

    it('names each sender as the chat socket does, so history and live messages match', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE' });
      // Newest first, as the query reads them.
      mockPrisma.conversationMessage.findMany.mockResolvedValue([
        { id: 'm-2', role: 'AGENT', senderExternalId: null, senderName: null, createdAt: new Date('2026-10-08T08:00:02.000Z') },
        { id: 'm-1', role: 'USER', senderExternalId: 'grace@example.com', senderName: 'grace@example.com', createdAt: new Date('2026-10-08T08:00:01.000Z') },
      ]);

      const messages = await conversationService.getRecentMessages('thread-db', 10);

      expect(messages.map((m) => [m.id, (m as { senderId: string | null }).senderId])).toEqual([
        ['m-1', 'grace@example.com'],
        ['m-2', null],
      ]);
    });

    it('reads the page before a message, in client order', async () => {
      const cursorAt = new Date('2026-10-08T08:00:01.000Z');
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE' });
      mockPrisma.conversationMessage.findFirst.mockResolvedValue({ createdAt: cursorAt, id: 'm-5' });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getRecentMessages('thread-db', 10, 'm-5');

      expect(mockPrisma.conversationMessage.findFirst).toHaveBeenCalledWith({
        where: { id: 'm-5', threadId: 'thread-db', internalStep: false },
        select: { createdAt: true, id: true },
      });
      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith({
        where: {
          threadId: 'thread-db',
          internalStep: false,
          OR: [{ createdAt: { lt: cursorAt } }, { createdAt: cursorAt, id: { lt: 'm-5' } }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
      });
    });

    it('reads no messages before a message the thread does not hold', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE' });
      mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

      expect(await conversationService.getRecentMessages('thread-db', 10, 'other-thread-message')).toEqual([]);
      expect(mockPrisma.conversationMessage.findMany).not.toHaveBeenCalled();
    });

    it('should default to DatabaseThreadProvider when thread is not found', async () => {
      const threadId = 'thread-missing';
      mockPrisma.conversationThread.findUnique.mockResolvedValue(null);
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getRecentMessages(threadId, 5);

      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Concise-mode visibility: client reads hide internal steps; the model read
  // (getThreadContext) keeps them so replay fidelity is unchanged.
  // ==========================================================================

  describe('internal-step visibility (DATABASE threads)', () => {
    it('getThread hides internal steps from client history', async () => {
      const threadId = 'thread-db';
      mockPrisma.conversationThread.findFirst.mockResolvedValue({
        id: threadId,
        agentId: 'agent-1',
        userId: 'user-1',
        threadSource: 'DATABASE',
      });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getThread('user-1', 'agent-1', threadId);

      // Client view: internal steps hidden, compacted rows kept (full scrollback).
      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId, internalStep: false },
        })
      );
    });

    it('getThread with a page holds the newest messages of the client view', async () => {
      const threadId = 'thread-db';
      mockPrisma.conversationThread.findFirst.mockResolvedValue({ id: threadId, threadSource: 'DATABASE' });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getThread('user-1', 'agent-1', threadId, { limit: 50 });

      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith({
        where: { threadId, internalStep: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
    });

    it('getThreadContext keeps internal steps for the model (no internalStep filter)', async () => {
      const threadId = 'thread-db';
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        compactionSummary: null,
        threadSource: 'DATABASE',
      });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getThreadContext(threadId);

      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId, isCompacted: false },
        })
      );
      // Explicitly assert the model read does NOT filter internal steps.
      const call = mockPrisma.conversationMessage.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('internalStep');
    });

    describe('a concise turn\'s hidden tool calls', () => {
      const at = (second: number) => new Date(Date.UTC(2026, 9, 8, 8, 0, second));
      const callIds = (message?: { toolCalls: unknown }) =>
        ((message?.toolCalls ?? []) as Array<{ id: string }>).map((c) => c.id);
      const call = (id: string) => ({ id, tool: `tool-${id}`, input: '{}', output: 'ok', success: true });
      const row = (id: string, role: 'USER' | 'AGENT', second: number, toolCalls: unknown[] | null = null, internalStep = false, triggeredBy = 'USER_INPUT') => ({
        id, threadId: 'thread-db', role, content: id, triggeredBy, toolCalls, blocks: null,
        senderExternalId: null, senderName: null, isCompacted: false, internalStep, createdAt: at(second),
      });

      beforeEach(() => {
        mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE', compactionSummary: null });
      });

      it('shows them on the answer, ahead of its own calls', async () => {
        // Newest first, as the client read returns them.
        mockPrisma.conversationMessage.findMany
          .mockResolvedValueOnce([row('answer', 'AGENT', 4, [call('own')]), row('question', 'USER', 1)])
          .mockResolvedValueOnce([row('step-1', 'AGENT', 2, [call('a')], true), row('step-2', 'AGENT', 3, [call('b')], true)]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

        const messages = await conversationService.getRecentMessages('thread-db', 10);

        const answer = messages.find((m) => m.id === 'answer');
        expect(callIds(answer)).toEqual(['a', 'b', 'own']);
        expect(mockPrisma.conversationMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
          where: { threadId: 'thread-db', role: 'AGENT', internalStep: true, createdAt: { lte: at(4) } },
        }));
      });

      it('bounds the window at the last message before the first one shown that a person sent or that answers one', async () => {
        mockPrisma.conversationMessage.findMany
          .mockResolvedValueOnce([row('answer', 'AGENT', 4)])
          .mockResolvedValueOnce([]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue({ createdAt: at(1) });

        await conversationService.getRecentMessages('thread-db', 1);

        expect(mockPrisma.conversationMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
          where: {
            threadId: 'thread-db',
            internalStep: false,
            triggeredBy: { in: ['USER_INPUT', 'AGENT_MESSAGE'] },
            createdAt: { lt: at(4) },
          },
        }));
        expect(mockPrisma.conversationMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gt: at(1), lte: at(4) } }),
        }));
      });

      it('shows a page that starts at the answer what the whole history shows, past a heartbeat mid-turn', async () => {
        const question = row('question', 'USER', 1);
        const heartbeat = row('heartbeat', 'AGENT', 3, null, false, 'HEARTBEAT');
        const answer = row('answer', 'AGENT', 5);
        const steps = [row('step-1', 'AGENT', 2, [call('a')], true), row('step-2', 'AGENT', 4, [call('b')], true)];
        // The window opens after the question, not after the heartbeat that precedes the page.
        mockPrisma.conversationMessage.findFirst.mockResolvedValueOnce({ createdAt: question.createdAt });
        mockPrisma.conversationMessage.findMany.mockResolvedValueOnce(steps);
        const [paged] = await conversationService.withHiddenStepToolCalls('thread-db', [answer]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValueOnce(null);
        mockPrisma.conversationMessage.findMany.mockResolvedValueOnce(steps);
        const whole = await conversationService.withHiddenStepToolCalls('thread-db', [question, heartbeat, answer]);

        expect(callIds(paged)).toEqual(['a', 'b']);
        expect(callIds(whole.find((m) => m.id === 'answer'))).toEqual(callIds(paged));
      });

      it('shows a live reply as a reload shows it', async () => {
        const question = row('question', 'USER', 1);
        const answer = row('answer', 'AGENT', 4, [call('own')]);
        const steps = [row('step', 'AGENT', 2, [call('a')], true)];
        mockPrisma.conversationMessage.findMany.mockResolvedValue(steps);

        mockPrisma.conversationMessage.findFirst.mockResolvedValueOnce({ createdAt: question.createdAt });
        const [live] = await conversationService.withHiddenStepToolCalls('thread-db', [answer]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValueOnce(null);
        const reload = await conversationService.withHiddenStepToolCalls('thread-db', [question, answer]);

        expect(callIds(live)).toEqual(['a', 'own']);
        expect(callIds(reload.find((m) => m.id === 'answer'))).toEqual(callIds(live));
      });

      it('makes no query for a person\'s message alone', async () => {
        const messages = [row('question', 'USER', 1)];

        expect(await conversationService.withHiddenStepToolCalls('thread-db', messages)).toBe(messages);
        expect(mockPrisma.conversationMessage.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.conversationMessage.findMany).not.toHaveBeenCalled();
      });

      it('skips a step that made no call, and keeps one written in the same millisecond as the answer', async () => {
        mockPrisma.conversationMessage.findMany.mockResolvedValue([
          row('narration', 'AGENT', 2, null, true),
          row('last-step', 'AGENT', 4, [call('a')], true),
        ]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue({ createdAt: at(1) });

        const [answer] = await conversationService.withHiddenStepToolCalls('thread-db', [row('answer', 'AGENT', 4)]);

        expect(callIds(answer)).toEqual(['a']);
      });

      it('shows a cancelled turn\'s calls nowhere, not on the next answer', async () => {
        mockPrisma.conversationMessage.findMany
          .mockResolvedValueOnce([
            row('answer', 'AGENT', 5, [call('own')]),
            row('next-question', 'USER', 3),
            row('question', 'USER', 1),
          ])
          .mockResolvedValueOnce([
            row('cancelled-step', 'AGENT', 2, [call('stale')], true),
            row('step', 'AGENT', 4, [call('fresh')], true),
          ]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

        const messages = await conversationService.getRecentMessages('thread-db', 10);

        const answer = messages.find((m) => m.id === 'answer');
        expect(callIds(answer)).toEqual(['fresh', 'own']);
        expect(messages.find((m) => m.id === 'next-question')?.toolCalls).toBeNull();
      });

      it('shows a cancelled turn\'s calls nowhere when another agent\'s message comes next, as for a person\'s', async () => {
        mockPrisma.conversationMessage.findMany
          .mockResolvedValueOnce([
            row('answer', 'AGENT', 5, [call('own')]),
            row('agent-message', 'USER', 3, null, false, 'AGENT_MESSAGE'),
            row('question', 'USER', 1),
          ])
          .mockResolvedValueOnce([
            row('cancelled-step', 'AGENT', 2, [call('stale')], true),
            row('step', 'AGENT', 4, [call('fresh')], true),
          ]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

        const messages = await conversationService.getRecentMessages('thread-db', 10);

        expect(callIds(messages.find((m) => m.id === 'answer'))).toEqual(['fresh', 'own']);
        expect(messages.find((m) => m.id === 'agent-message')?.toolCalls).toBeNull();
      });

      it('shows a cancelled turn\'s calls nowhere when a heartbeat speaks next', async () => {
        mockPrisma.conversationMessage.findMany.mockResolvedValue([row('cancelled-step', 'AGENT', 2, [call('stale')], true)]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue({ createdAt: at(1) });

        const [heartbeat] = await conversationService.withHiddenStepToolCalls('thread-db', [
          row('heartbeat', 'AGENT', 3, null, false, 'HEARTBEAT'),
        ]);

        expect(heartbeat.toolCalls).toBeNull();
      });

      it('passes over a heartbeat that lands mid-turn, and shows the calls on the answer', async () => {
        mockPrisma.conversationMessage.findMany.mockResolvedValue([row('step', 'AGENT', 2, [call('a')], true)]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

        const messages = await conversationService.withHiddenStepToolCalls('thread-db', [
          row('question', 'USER', 1),
          row('heartbeat', 'AGENT', 3, null, false, 'HEARTBEAT'),
          row('answer', 'AGENT', 4),
        ]);

        expect(messages.find((m) => m.id === 'heartbeat')?.toolCalls).toBeNull();
        expect(callIds(messages.find((m) => m.id === 'answer'))).toEqual(['a']);
      });

      it('shows them on a live-read thread\'s answer too, so a reload matches the live reply', async () => {
        mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'SLACK', compactionSummary: null });
        conversationService.registerThreadProvider('SLACK', {
          getMessages: vi.fn(),
          getRecentMessages: vi.fn(async () => [row('live-question', 'USER', 1), row('live-answer', 'AGENT', 3)]),
        } as never);
        mockPrisma.conversationMessage.findMany.mockResolvedValue([row('step', 'AGENT', 2, [call('a')], true)]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);

        const messages = await conversationService.getRecentMessages('thread-db', 10);

        expect(callIds(messages.find((m) => m.id === 'live-answer'))).toEqual(['a']);
      });

      it('leaves the model\'s read as stored, so each call is replayed once', async () => {
        mockPrisma.conversationMessage.findMany.mockResolvedValueOnce([
          row('question', 'USER', 1),
          row('step', 'AGENT', 2, [call('a')], true),
          row('answer', 'AGENT', 3, [call('own')]),
        ]);

        const { messages } = await conversationService.getThreadContext('thread-db');

        const replayed = messages.flatMap((m) => (m.toolCalls as Array<{ id: string }> | null) ?? []).map((c) => c.id);
        expect(replayed).toEqual(['a', 'own']);
        expect(mockPrisma.conversationMessage.findFirst).not.toHaveBeenCalled();
      });

      it('shows them in the web history too', async () => {
        mockPrisma.conversationThread.findFirst.mockResolvedValue({
          id: 'thread-db', agentId: 'agent-1', userId: 'user-1', threadSource: 'DATABASE', contextModel: null, contextTokens: null,
        });
        mockPrisma.conversationMessage.findMany
          .mockResolvedValueOnce([row('question', 'USER', 1), row('answer', 'AGENT', 3)])
          .mockResolvedValueOnce([row('step', 'AGENT', 2, [call('a')], true)]);
        mockPrisma.conversationMessage.findFirst.mockResolvedValue(null);
        mockPrisma.messageAttachment.findMany.mockResolvedValue([]);

        const thread = await conversationService.getThread('user-1', 'agent-1', 'thread-db');

        const answer = thread?.messages.find((m) => m.id === 'answer');
        expect(callIds(answer)).toEqual(['a']);
      });
    });
  });

  // ==========================================================================
  // Get active thread
  // ==========================================================================

  describe('findLatestWebThread', () => {
    it('should return the latest web thread for a user', async () => {
      const latestThread = createTestThread();
      mockPrisma.conversationThread.findFirst.mockResolvedValue(latestThread);

      const result = await conversationService.findLatestWebThread('agent-123', 'user-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(latestThread.id);
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123', externalThreadId: null },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return null when no thread exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);

      const result = await conversationService.findLatestWebThread('agent-123', 'user-no-thread');

      expect(result).toBeNull();
      expect(mockPrisma.conversationThread.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Set external thread ID
  // ==========================================================================

  describe('setExternalId', () => {
    it('should update thread with external thread ID', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });

      await conversationService.setExternalId('thread-123', '1234567890.123456');

      expect(mockPrisma.conversationThread.updateMany).toHaveBeenCalledWith({
        where: { id: 'thread-123' },
        data: { externalThreadId: '1234567890.123456' },
      });
    });
  });

  // ==========================================================================
  // Context usage
  // ==========================================================================

  describe('setThreadContextUsage', () => {
    it('overwrites the thread snapshot with the latest measurement', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });

      await conversationService.setThreadContextUsage('thread-123', 412_300, 'us.anthropic.claude-opus-5');

      expect(mockPrisma.conversationThread.updateMany).toHaveBeenCalledWith({
        where: { id: 'thread-123' },
        data: { contextTokens: 412_300, contextModel: 'us.anthropic.claude-opus-5' },
      });
    });

    it('is a no-op when the thread was deleted mid-turn', async () => {
      // updateMany (not update) so a vanished thread doesn't throw P2025 and
      // abort the turn that was only trying to record a display metric.
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        conversationService.setThreadContextUsage('gone', 100, 'us.anthropic.claude-opus-5')
      ).resolves.toBeUndefined();
    });
  });

  describe('getThread derives contextUsage', () => {
    function mockThread(contextTokens: number | null, contextModel: string | null) {
      mockPrisma.conversationThread.findFirst.mockResolvedValue({
        id: 'thread-db',
        agentId: 'agent-1',
        userId: 'user-1',
        threadSource: 'DATABASE',
        contextTokens,
        contextModel,
      });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
    }

    it('turns the stored snapshot into a percentage so clients need no window table', async () => {
      mockThread(250_000, 'us.anthropic.claude-opus-5');

      const thread = await conversationService.getThread('user-1', 'agent-1', 'thread-db');

      expect(thread?.contextUsage).toEqual({
        threadId: 'thread-db',
        modelId: 'us.anthropic.claude-opus-5',
        usedTokens: 250_000,
        windowTokens: 1_000_000,
        usedPercent: 25,
      });
    });

    it('is null before the thread has run a turn', async () => {
      mockThread(null, null);

      const thread = await conversationService.getThread('user-1', 'agent-1', 'thread-db');

      expect(thread?.contextUsage).toBeNull();
    });

    it('is null when the stored model is no longer recognized', async () => {
      mockThread(250_000, 'some-retired-deployment');

      const thread = await conversationService.getThread('user-1', 'agent-1', 'thread-db');

      expect(thread?.contextUsage).toBeNull();
    });
  });

  // ==========================================================================
  // Telemetry
  // ==========================================================================

  describe('telemetry', () => {
    it('emits "thread created" when getOrCreateLatestThread creates a thread', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-new' }),
      );

      await conversationService.getOrCreateLatestThread('agent-123', 'user-123');

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-new',
        'thread.source': 'database',
      });
    });

    it('does not emit "thread created" when an active thread already exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(createTestThread());

      await conversationService.getOrCreateLatestThread('agent-123', 'user-123');

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "thread created" when the external-id upsert creates a thread', async () => {
      const now = new Date('2025-01-15T12:00:00Z');
      mockPrisma.conversationThread.upsert.mockResolvedValue(
        createTestThread({ id: 'thread-live', createdAt: now, updatedAt: now }),
      );

      await conversationService.getOrCreateThreadByExternalId(
        'user-123', 'agent-123', '1234.5678', { source: 'SLACK', channelId: 'C123' },
      );

      expect(mockPrisma.conversationThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ threadSource: 'SLACK', externalChannelId: 'C123' }),
          update: { threadSource: 'SLACK', externalChannelId: 'C123' },
        }),
      );
      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-live',
        'thread.source': 'slack',
      });
    });

    it('emits thread.source=database for a top-level DM thread (no channelId → DATABASE)', async () => {
      const now = new Date('2025-01-15T12:00:00Z');
      mockPrisma.conversationThread.upsert.mockResolvedValue(
        createTestThread({ id: 'thread-dm', createdAt: now, updatedAt: now }),
      );

      // Top-level DM: keyed by its conversation id, not live-read → DATABASE.
      await conversationService.getOrCreateThreadByExternalId(
        'user-123', 'agent-123', 'D07ERBJA69M',
      );

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-dm',
        'thread.source': 'database',
      });
    });

    it('does not emit "thread created" when the external-id upsert hits an existing thread', async () => {
      mockPrisma.conversationThread.upsert.mockResolvedValue(
        createTestThread({
          createdAt: new Date('2025-01-15T12:00:00Z'),
          updatedAt: new Date('2025-01-15T13:00:00Z'),
        }),
      );

      await conversationService.getOrCreateThreadByExternalId('user-123', 'agent-123', '1234.5678');

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "message added" with role and trigger on addMessage', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'msg-1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());

      await conversationService.addMessage('thread-123', {
        content: 'hi',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      });

      expect(mockTrackEvent).toHaveBeenCalledWith('message added', null, {
        'agent.id': 'agent-123',
        'thread.id': 'thread-123',
        'message.role': 'USER',
        'message.triggered_by': 'USER_INPUT',
        'message.internal': 'false',
      });
    });

    // A recall row is a USER row the runtime wrote. Counted with the rest it steps
    // every message-volume metric at deploy for a reason that is not user behaviour.
    it('marks an internal row so it does not read as a user message', async () => {
      mockPrisma.conversationMessage.create.mockResolvedValue({ id: 'msg-1' });
      mockPrisma.conversationThread.update.mockResolvedValue(createTestThread());

      await conversationService.addMessage('thread-123', {
        content: 'Context:\n<recalled-memories>\n- x\n</recalled-memories>',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
        internalStep: true,
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'message added',
        null,
        expect.objectContaining({ 'message.internal': 'true' }),
      );
    });

    it('emits "thread external id set" on setExternalId', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });

      await conversationService.setExternalId('thread-123', '1234.5678');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'thread external id set',
        null,
        expect.objectContaining({ 'thread.id': 'thread-123' }),
      );
    });
  });

  // ==========================================================================
  // Live-read thread providers
  // ==========================================================================

  describe('registerThreadProvider', () => {
    it('reads a thread through the provider registered for its source', async () => {
      const live = {
        getMessages: vi.fn(async () => [{ id: 'live-1' }]),
        getRecentMessages: vi.fn(async () => [{ id: 'live-2', senderExternalId: 'U1' }]),
      };
      conversationService.registerThreadProvider('SLACK', live as never);
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        compactionSummary: null,
        threadSource: 'SLACK',
      });

      const context = await conversationService.getThreadContext('thread-live');
      const recent = await conversationService.getRecentMessages('thread-live', 5);

      expect(live.getMessages).toHaveBeenCalledWith('thread-live');
      expect(context).toEqual({ compactionSummary: null, threadSource: 'SLACK', messages: [{ id: 'live-1' }] });
      expect(live.getRecentMessages).toHaveBeenCalledWith('thread-live', 5, { view: 'client' });
      expect(recent).toEqual([{ id: 'live-2', senderExternalId: 'U1', senderId: 'U1' }]);
      expect(mockPrisma.conversationMessage.findMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Single-thread mode
  // ==========================================================================

  describe('single-thread mode', () => {
    beforeEach(() => {
      config.threadMode = 'single';
      runtimeState.clear();
    });
    afterEach(() => {
      config.threadMode = 'multi';
    });

    /** The newest message the person wrote is in `conversation`. */
    function wroteLastIn(conversation: ReturnType<typeof createTestThread> | null) {
      mockPrisma.conversationMessage.findFirst.mockResolvedValue(conversation ? { thread: conversation } : null);
    }

    /** `conversation` is the stored one conversation, and its row exists. */
    function stored(conversation: ReturnType<typeof createTestThread>) {
      runtimeState.set('singleThread', conversation.id);
      mockPrisma.conversationThread.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
        where.id === conversation.id ? conversation : null,
      );
    }

    it('keeps the conversation the person wrote in last, not an emptier newer one, and stores it', async () => {
      wroteLastIn(createTestThread({ id: 'thread-written' }));

      const thread = await conversationService.findLatestWebThread('agent-123', 'user-123');

      expect(thread?.id).toBe('thread-written');
      expect(mockPrisma.conversationMessage.findFirst).toHaveBeenCalledWith({
        where: {
          role: 'USER',
          triggeredBy: 'USER_INPUT',
          internalStep: false,
          thread: { agentId: 'agent-123', userId: 'user-123', externalThreadId: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { thread: true },
      });
      expect(mockPrisma.conversationThread.findFirst).not.toHaveBeenCalled();
      expect(runtimeState.get('singleThread')).toBe('thread-written');
    });

    it('keeps the newest thread when nobody wrote yet, and creates one when there is none', async () => {
      wroteLastIn(null);
      mockPrisma.conversationThread.findFirst.mockResolvedValueOnce(createTestThread({ id: 'thread-newest' }));
      expect((await conversationService.findLatestWebThread('agent-123', 'user-123'))?.id).toBe('thread-newest');

      runtimeState.clear();
      mockPrisma.conversationThread.findFirst.mockResolvedValueOnce(null);
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread({ id: 'thread-new' }));
      expect((await conversationService.getOrCreateLatestThread('agent-123', 'user-123')).id).toBe('thread-new');
    });

    it('keeps the stored conversation when the person writes in another thread', async () => {
      stored(createTestThread({ id: 'thread-one' }));
      wroteLastIn(createTestThread({ id: 'thread-other' }));

      expect((await conversationService.findLatestWebThread('agent-123', 'user-123'))?.id).toBe('thread-one');
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { id: 'thread-one', agentId: 'agent-123', userId: 'user-123', externalThreadId: null },
      });
      expect(mockPrisma.conversationMessage.findFirst).not.toHaveBeenCalled();
    });

    it('chooses again when the stored conversation is gone', async () => {
      runtimeState.set('singleThread', 'thread-gone');
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      wroteLastIn(createTestThread({ id: 'thread-written' }));

      expect((await conversationService.findLatestWebThread('agent-123', 'user-123'))?.id).toBe('thread-written');
      expect(runtimeState.get('singleThread')).toBe('thread-written');
    });

    it('forgets the stored conversation', async () => {
      runtimeState.set('singleThread', 'thread-one');

      await conversationService.forgetSingleThread();

      expect(runtimeState.has('singleThread')).toBe(false);
    });

    it('answers a request for a new thread with the one conversation', async () => {
      stored(createTestThread({ id: 'thread-one' }));

      const started = await conversationService.startNewThread('agent-123', 'user-123', { workspaceRoot: '/repo' });
      const fresh = await conversationService.getOrCreateFreshThread('agent-123', 'user-123');
      const latest = await conversationService.getOrCreateLatestThread('agent-123', 'user-123');

      expect([started.id, fresh.id, latest.id]).toEqual(['thread-one', 'thread-one', 'thread-one']);
      expect(mockPrisma.conversationThread.create).not.toHaveBeenCalled();
    });

    it('lists, opens and reads only the one conversation among web threads', async () => {
      stored(createTestThread({ id: 'thread-one' }));
      const onlyTheConversation = { OR: [{ externalThreadId: { not: null } }, { id: 'thread-one' }] };
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { threadSource: 'DATABASE' });
      await conversationService.getOwnedThreadId('user-123', 'agent-123', 'thread-older');
      await conversationService.getThread('user-123', 'agent-123', 'thread-older');

      expect(mockPrisma.conversationThread.findMany.mock.calls[0][0].where).toMatchObject(onlyTheConversation);
      const reads = mockPrisma.conversationThread.findFirst.mock.calls.filter(([query]) => query.where.id === 'thread-older');
      expect(reads).toHaveLength(2);
      for (const [query] of reads) {
        expect(query.where).toMatchObject(onlyTheConversation);
      }
    });

    it('writes a run or a turn named for another web thread to the one conversation', async () => {
      stored(createTestThread({ id: 'thread-one' }));
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-123',
        userId: 'user-123',
        externalThreadId: null,
      });

      expect(await conversationService.writableThreadId('thread-older')).toBe('thread-one');
    });

    it('writes to a channel thread as named', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        agentId: 'agent-123',
        userId: 'user-123',
        externalThreadId: 'C123:1700000000.000100',
      });

      expect(await conversationService.writableThreadId('thread-slack')).toBe('thread-slack');
      expect(runtimeState.size).toBe(0);
    });
  });

  it('writes to the named thread in multi-thread mode', async () => {
    expect(await conversationService.writableThreadId('thread-older')).toBe('thread-older');
    expect(mockPrisma.conversationThread.findUnique).not.toHaveBeenCalled();
  });
});
