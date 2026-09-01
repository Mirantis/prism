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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    slackMapping: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  default: mockPrisma,
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

    it('SLACK filter is untouched (no externalThreadId constraint)', async () => {
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
    it('should return the existing latest (non-Slack) thread', async () => {
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
  });

  // ==========================================================================
  // Get active thread
  // ==========================================================================

  describe('getLatestThread', () => {
    it('should return the latest (non-Slack) thread for a user', async () => {
      const latestThread = createTestThread();
      mockPrisma.conversationThread.findFirst.mockResolvedValue(latestThread);

      const result = await conversationService.getLatestThread('user-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(latestThread.id);
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-123', externalThreadId: null },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return null when no thread exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);

      const result = await conversationService.getLatestThread('user-no-thread');

      expect(result).toBeNull();
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
        createTestThread({ id: 'thread-slack', createdAt: now, updatedAt: now }),
      );

      await conversationService.getOrCreateThreadByExternalId(
        'user-123', 'agent-123', '1234.5678', { channelId: 'C123' },
      );

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-slack',
        'thread.source': 'slack',
      });
    });

    it('emits thread.source=database for a top-level DM thread (no channelId → DATABASE)', async () => {
      const now = new Date('2025-01-15T12:00:00Z');
      mockPrisma.conversationThread.upsert.mockResolvedValue(
        createTestThread({ id: 'thread-dm', createdAt: now, updatedAt: now }),
      );

      // Top-level DM: keyed by dmChannelId, no channelId option → DATABASE.
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
      });
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
  // getChannelContext — channel-neutral routing for thread-bound delivery
  // ==========================================================================

  describe('getChannelContext', () => {
    it('returns a websocket context for non-slack threads (no DB lookup)', async () => {
      const ctx = await conversationService.getChannelContext('thread-1', 'websocket');

      expect(ctx).toEqual({ channel: 'websocket', threadId: 'thread-1' });
      expect(mockPrisma.conversationThread.findUnique).not.toHaveBeenCalled();
    });

    it('recovers the Slack thread_ts + channel for a channel-bound thread', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: '1700000000.000100',
        externalChannelId: 'C123',
        threadSource: 'SLACK',
        userId: 'user-123',
        agentId: 'agent-123',
      });

      const ctx = await conversationService.getChannelContext('thread-1', 'slack', 'C123');

      expect(ctx).toEqual({
        channel: 'slack',
        channelId: 'C123',
        threadTs: '1700000000.000100',
        threadId: 'thread-1',
      });
      // A known channel id means no DM fallback lookup is needed.
      expect(mockPrisma.slackMapping.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the user DM channel for a DM-originated thread with no channel id', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: null,
        externalChannelId: null,
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue({ dmChannelId: 'D999' });

      const ctx = await conversationService.getChannelContext('thread-1', 'slack');

      expect(mockPrisma.slackMapping.findFirst).toHaveBeenCalledWith({
        where: { lensUserId: 'user-123', agentId: 'agent-123', dmChannelId: { not: null } },
        select: { dmChannelId: true },
      });
      // Scoped to the DM channel (so the Slack adapter won't broadcast to mappings).
      expect(ctx).toEqual({
        channel: 'slack',
        channelId: 'D999',
        threadTs: undefined,
        threadId: 'thread-1',
      });
      // A resolved channel is deliverable — no warning.
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('does NOT treat a top-level DM thread externalThreadId as a Slack thread_ts', async () => {
      // Top-level DMs are threadSource=DATABASE and store the dmChannelId in
      // externalThreadId. A cron/goal continuation must post top-level (into the
      // DM channel), NOT with thread_ts=dmChannelId (an invalid Slack ts).
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: 'D07ERBJA69M',
        externalChannelId: null,
        threadSource: 'DATABASE',
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue({ dmChannelId: 'D07ERBJA69M' });

      const ctx = await conversationService.getChannelContext('thread-1', 'slack');

      expect(ctx).toEqual({
        channel: 'slack',
        channelId: 'D07ERBJA69M',
        threadTs: undefined,
        threadId: 'thread-1',
      });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('warns when no Slack channel can be resolved (undeliverable resume)', async () => {
      mockPrisma.conversationThread.findUnique.mockResolvedValue({
        externalThreadId: null,
        externalChannelId: null,
        userId: 'user-123',
        agentId: 'agent-123',
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValue(null);

      const ctx = await conversationService.getChannelContext('thread-1', 'slack');

      expect(ctx.channelId).toBeUndefined();
      // A thread-bound resume with no resolvable channel is NOT rerouted to the
      // main channel — it's logged and left undelivered.
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No Slack channel resolved'), 'thread-1');
    });
  });
});
