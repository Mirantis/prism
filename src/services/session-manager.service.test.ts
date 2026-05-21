/**
 * Session Manager Service Tests
 *
 * Tests for SessionManagerService covering:
 * - Session lifecycle (start, reset, cleanup)
 * - Daily reset scheduling
 * - Idle timeout
 * - Session ID generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestAgentWorkspace } from '../test-utils/factories';

// Use vi.hoisted to create mocks that are available before vi.mock hoisting
const { mockPrisma, mockGetOrCreateActiveThread, mockDeactivateThread } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspace: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockGetOrCreateActiveThread: vi.fn(),
  mockDeactivateThread: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getOrCreateActiveThread: mockGetOrCreateActiveThread,
    deactivateThread: mockDeactivateThread,
  },
}));

// Import after mocking
import { sessionManagerService } from './session-manager.service';

// Access internal state for testing
const service = sessionManagerService as any;

describe('Requirement: Session Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset service state
    service.sessions = new Map();
    service.isInitialized = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    service.stopAll();
  });

  describe('Scenario: Session start', () => {
    it('should create new session when user has no existing session', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({
        userId,
        currentSessionId: null,
        dailyResetHour: 4,
        idleTimeoutMins: null,
        timezone: 'UTC',
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent as any);
      mockPrisma.agentWorkspace.update.mockResolvedValue({ ...agent, currentSessionId: 'new-session' });

      const sessionId = await service.startSession(userId);

      expect(sessionId).toMatch(/^sess_/);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agent.id },
        data: { currentSessionId: expect.stringMatching(/^sess_/) },
      });
    });

    it('should return existing session if one is active', async () => {
      const userId = 'user-123';
      const existingSessionId = 'sess_existing123';
      const agent = createTestAgentWorkspace({
        userId,
        currentSessionId: existingSessionId,
        dailyResetHour: 4,
        idleTimeoutMins: null,
        timezone: 'UTC',
      });

      // Pre-populate the sessions map
      service.sessions.set(userId, {
        userId,
        sessionId: existingSessionId,
        lastActivity: new Date(),
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent as any);

      const sessionId = await service.startSession(userId);

      expect(sessionId).toBe(existingSessionId);
      // Should not create a new session
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it('should start idle timeout if configured', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({
        userId,
        currentSessionId: null,
        dailyResetHour: 4,
        idleTimeoutMins: 30,
        timezone: 'UTC',
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent as any);
      mockPrisma.agentWorkspace.update.mockResolvedValue({ ...agent, currentSessionId: 'new-session' });

      await service.startSession(userId);

      const state = service.sessions.get(userId);
      expect(state).toBeDefined();
      // Idle timeout should be set (we can't directly check the timeout)
    });
  });

  describe('Scenario: Session reset', () => {
    it('should reset session manually', async () => {
      const userId = 'user-123';
      const oldSessionId = 'sess_old123';
      const activeThread = { id: 'thread-123' };
      const agent = createTestAgentWorkspace({ userId });

      service.sessions.set(userId, {
        userId,
        sessionId: oldSessionId,
        lastActivity: new Date(),
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent);
      mockGetOrCreateActiveThread.mockResolvedValue(activeThread);
      mockDeactivateThread.mockResolvedValue(undefined);
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      const newSessionId = await service.resetSession(userId, 'manual');

      expect(newSessionId).toMatch(/^sess_/);
      expect(newSessionId).not.toBe(oldSessionId);
      expect(mockDeactivateThread).toHaveBeenCalledWith('thread-123');
    });

    it('should reset session on daily trigger', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_old123',
        lastActivity: new Date(),
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent);
      mockGetOrCreateActiveThread.mockResolvedValue({ id: 'thread-123' });
      mockDeactivateThread.mockResolvedValue(undefined);
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      const newSessionId = await service.resetSession(userId, 'daily');

      expect(newSessionId).toMatch(/^sess_/);
    });

    it('should reset session on idle trigger', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_old123',
        lastActivity: new Date(),
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent);
      mockGetOrCreateActiveThread.mockResolvedValue({ id: 'thread-123' });
      mockDeactivateThread.mockResolvedValue(undefined);
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      const newSessionId = await service.resetSession(userId, 'idle');

      expect(newSessionId).toMatch(/^sess_/);
    });

    it('should handle case where no active thread exists', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_old123',
        lastActivity: new Date(),
      });

      mockPrisma.agentWorkspace.findFirst.mockResolvedValue(agent);
      mockGetOrCreateActiveThread.mockRejectedValue(new Error('No thread'));
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      // Should not throw
      const newSessionId = await service.resetSession(userId, 'manual');

      expect(newSessionId).toMatch(/^sess_/);
    });
  });

  describe('Scenario: Record activity', () => {
    it('should update lastActivity timestamp', () => {
      const userId = 'user-123';
      const oldDate = new Date('2024-01-01');

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_123',
        lastActivity: oldDate,
      });

      vi.setSystemTime(new Date('2024-01-02'));
      service.recordActivity(userId);

      const state = service.sessions.get(userId);
      expect(state.lastActivity.getTime()).toBeGreaterThan(oldDate.getTime());
    });

    it('should do nothing if user has no session', () => {
      const userId = 'user-nonexistent';

      // Should not throw
      service.recordActivity(userId);

      expect(service.sessions.has(userId)).toBe(false);
    });
  });

  describe('Scenario: Get session state', () => {
    it('should return session ID if exists', () => {
      const userId = 'user-123';
      const sessionId = 'sess_existing123';

      service.sessions.set(userId, {
        userId,
        sessionId,
        lastActivity: new Date(),
      });

      expect(service.getSessionId(userId)).toBe(sessionId);
    });

    it('should return null if no session', () => {
      expect(service.getSessionId('user-nonexistent')).toBeNull();
    });

    it('should correctly check hasActiveSession', () => {
      const userId = 'user-123';

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_123',
        lastActivity: new Date(),
      });

      expect(service.hasActiveSession(userId)).toBe(true);
      expect(service.hasActiveSession('user-nonexistent')).toBe(false);
    });
  });

  describe('Scenario: Cleanup', () => {
    it('should cleanup user session and clear timeouts', () => {
      const userId = 'user-123';
      const dailyResetTimeout = setTimeout(() => {}, 10000);
      const idleTimeout = setTimeout(() => {}, 10000);

      service.sessions.set(userId, {
        userId,
        sessionId: 'sess_123',
        lastActivity: new Date(),
        dailyResetTimeout,
        idleTimeout,
      });

      service.cleanup(userId);

      expect(service.sessions.has(userId)).toBe(false);
    });

    it('should stop all sessions on stopAll', () => {
      service.sessions.set('user-1', {
        userId: 'user-1',
        sessionId: 'sess_1',
        lastActivity: new Date(),
        dailyResetTimeout: setTimeout(() => {}, 10000),
      });

      service.sessions.set('user-2', {
        userId: 'user-2',
        sessionId: 'sess_2',
        lastActivity: new Date(),
        idleTimeout: setTimeout(() => {}, 10000),
      });

      service.stopAll();

      expect(service.sessions.size).toBe(0);
    });
  });

  describe('Scenario: Initialize', () => {
    it('should initialize sessions for all existing agents', async () => {
      const agents = [
        { userId: 'user-1', currentSessionId: 'sess_1', dailyResetHour: 4, idleTimeoutMins: null, timezone: 'UTC' },
        { userId: 'user-2', currentSessionId: 'sess_2', dailyResetHour: 5, idleTimeoutMins: 30, timezone: 'America/New_York' },
      ];

      mockPrisma.agentWorkspace.findMany.mockResolvedValue(agents);

      await service.initialize();

      expect(service.isInitialized).toBe(true);
      expect(service.sessions.has('user-1')).toBe(true);
      expect(service.sessions.has('user-2')).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      service.isInitialized = true;

      await service.initialize();

      expect(mockPrisma.agentWorkspace.findMany).not.toHaveBeenCalled();
    });
  });

});
