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
    status: 'ACTIVE',
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
        orderBy: { updatedAt: 'desc' },
        take: 20,
      });
    });

    it('should filter threads by status', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([
        createTestThread({ status: 'ACTIVE' }),
      ]);

      await conversationService.listThreads('user-123', 'agent-123', { status: 'ACTIVE' });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123', status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      });
    });

    it('should respect custom limit', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123', { limit: 5 });

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123' },
        orderBy: { updatedAt: 'desc' },
        take: 5,
      });
    });

    it('should default to 20 when no limit provided', async () => {
      mockPrisma.conversationThread.findMany.mockResolvedValue([]);

      await conversationService.listThreads('user-123', 'agent-123');

      expect(mockPrisma.conversationThread.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123', userId: 'user-123' },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      });
    });
  });

  // ==========================================================================
  // Get or create active thread
  // ==========================================================================

  describe('getOrCreateActiveThread', () => {
    it('should return existing active thread', async () => {
      const existingThread = createTestThread({ status: 'ACTIVE' });
      mockPrisma.conversationThread.findFirst.mockResolvedValue(existingThread);

      const result = await conversationService.getOrCreateActiveThread('agent-123', 'user-123');

      expect(result.id).toBe(existingThread.id);
      expect(mockPrisma.conversationThread.create).not.toHaveBeenCalled();
    });

    it('should create new thread if none exists', async () => {
      const newThread = createTestThread();
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      mockPrisma.conversationThread.create.mockResolvedValue(newThread);

      await conversationService.getOrCreateActiveThread('agent-123', 'user-123');

      expect(mockPrisma.conversationThread.create).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Start a new active thread (CLI open)
  // ==========================================================================

  describe('startNewActiveThread', () => {
    it('archives prior active database threads then creates a fresh ACTIVE thread', async () => {
      const newThread = createTestThread({ id: 'thread-new' });
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.conversationThread.create.mockResolvedValue(newThread);

      const result = await conversationService.startNewActiveThread('agent-123', 'user-123');

      // Archives only this agent+user's active DATABASE threads (Slack/external untouched).
      expect(mockPrisma.conversationThread.updateMany).toHaveBeenCalledWith({
        where: {
          agentId: 'agent-123',
          userId: 'user-123',
          status: 'ACTIVE',
          externalThreadId: null,
        },
        data: { status: 'NON_ACTIVE' },
      });
      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123', status: 'ACTIVE' },
      });
      expect(result.id).toBe('thread-new');
    });

    it('archives before creating (does not resume an existing active thread)', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread());

      await conversationService.startNewActiveThread('agent-123', 'user-123');

      // findFirst is the get-or-create lookup; startNew never reuses a thread.
      expect(mockPrisma.conversationThread.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.conversationThread.create).toHaveBeenCalled();
    });

    it('emits "thread created" telemetry for the new thread', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-fresh' }),
      );

      await conversationService.startNewActiveThread('agent-123', 'user-123');

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-fresh',
        'thread.source': 'database',
      });
    });

    it('persists workspaceRoot when provided', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread());

      await conversationService.startNewActiveThread('agent-123', 'user-123', {
        workspaceRoot: '/home/me/project',
      });

      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: {
          agentId: 'agent-123',
          userId: 'user-123',
          status: 'ACTIVE',
          workspaceRoot: '/home/me/project',
        },
      });
    });

    it('omits workspaceRoot when empty / whitespace-only', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.conversationThread.create.mockResolvedValue(createTestThread());

      await conversationService.startNewActiveThread('agent-123', 'user-123', {
        workspaceRoot: '   ',
      });

      expect(mockPrisma.conversationThread.create).toHaveBeenCalledWith({
        data: { agentId: 'agent-123', userId: 'user-123', status: 'ACTIVE' },
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

      expect(result.role).toBe('USER');
      expect(result.content).toBe('What pods are running?');
      expect(mockPrisma.conversationMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          threadId,
          role: 'USER',
          content: 'What pods are running?',
          triggeredBy: 'USER_INPUT',
        }),
      });
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

  describe('getActiveThread', () => {
    it('should return the active thread for a user', async () => {
      const activeThread = createTestThread({ status: 'ACTIVE' });
      mockPrisma.conversationThread.findFirst.mockResolvedValue(activeThread);

      const result = await conversationService.getActiveThread('user-123');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('ACTIVE');
      expect(mockPrisma.conversationThread.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-123', status: 'ACTIVE', externalThreadId: null },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('should return null when no active thread exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);

      const result = await conversationService.getActiveThread('user-no-thread');

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
    it('emits "thread created" when getOrCreateActiveThread creates a thread', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(null);
      mockPrisma.conversationThread.create.mockResolvedValue(
        createTestThread({ id: 'thread-new' }),
      );

      await conversationService.getOrCreateActiveThread('agent-123', 'user-123');

      expect(mockTrackEvent).toHaveBeenCalledWith('thread created', 'user-123', {
        'agent.id': 'agent-123',
        'thread.id': 'thread-new',
        'thread.source': 'database',
      });
    });

    it('does not emit "thread created" when an active thread already exists', async () => {
      mockPrisma.conversationThread.findFirst.mockResolvedValue(createTestThread());

      await conversationService.getOrCreateActiveThread('agent-123', 'user-123');

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

    it('emits "thread archived" on deactivateThread', async () => {
      mockPrisma.conversationThread.updateMany.mockResolvedValue({ count: 1 });

      await conversationService.deactivateThread('thread-123', 'user-123');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'thread archived',
        'user-123',
        expect.objectContaining({ 'thread.id': 'thread-123' }),
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
});
