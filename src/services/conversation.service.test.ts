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
      upsert: vi.fn(),
    },
    conversationMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  default: mockPrisma,
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
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

    it('should filter threads by threadSource (excludes Slack from the resume list)', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { threadSource: 'DATABASE' });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123', threadSource: 'DATABASE' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });
  });

  // ==========================================================================
  // Resume an existing thread (CLI --resume)
  // ==========================================================================

  describe('resumeThread', () => {
    it('bumps the target thread createdAt so it becomes the latest', async () => {
      const target = createTestThread({ id: 'thread-x' });
      mockPrisma.conversationThread.findFirst.mockResolvedValue(target);
      mockPrisma.conversationThread.update.mockResolvedValue({ ...target });

      const result = await conversationService.resumeThread('agent-123', 'user-123', 'thread-x');

      // Only a database (non-Slack) thread owned by this agent+user.
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { id: 'thread-x', agentId: 'agent-123', userId: 'user-123', externalThreadId: null },
      });
      // Bring it to the front by bumping createdAt (latest = most recent).
      expect(mockPrisma.conversationThread.update).toHaveBeenCalledWith({
        where: { id: 'thread-x' },
        data: { createdAt: expect.any(Date) },
      });
      expect(result?.id).toBe('thread-x');
    });

    it('returns null and updates nothing when the thread is missing / not owned', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);

      const result = await conversationService.resumeThread('agent-123', 'user-123', 'missing');

      expect(result).toBeNull();
      expect(mockPrisma.conversationThread.update).not.toHaveBeenCalled();
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
        content: 'keuruun saha translations now please',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
      });

      // `title: null` in the where clause makes this fire only for the first
      // user message — later messages are a no-op (title already set).
      expect(mockPrisma.conversationThread.updateMany).toHaveBeenCalledWith({
        where: { id: 'thread-1', title: null },
        data: { title: 'keuruun saha translat...' },
      });
      expect(result.titleSet).toBe('keuruun saha translat...');
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
  });

  // ==========================================================================
  // Provider resolution
  // ==========================================================================

  describe('getRecentMessages', () => {
    it('should use DatabaseThreadProvider for DATABASE threads', async () => {
      const threadId = 'thread-db';
      mockPrisma.conversationThread.findUnique.mockResolvedValue({ threadSource: 'DATABASE' });
      mockPrisma.conversationMessage.findMany.mockResolvedValue([]);

      await conversationService.getRecentMessages(threadId, 10);

      expect(mockPrisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { threadId, isCompacted: false },
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
  // Token count
  // ==========================================================================

  describe('getThreadTokenCount', () => {
    it('should return aggregated token count', async () => {
      mockPrisma.conversationMessage.aggregate.mockResolvedValue({
        _sum: { tokenCount: 300 },
      });

      const tokenCount = await conversationService.getThreadTokenCount('thread-123');

      expect(tokenCount).toBe(300);
      expect(mockPrisma.conversationMessage.aggregate).toHaveBeenCalledWith({
        where: { threadId: 'thread-123', isCompacted: false },
        _sum: { tokenCount: true },
      });
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
});
