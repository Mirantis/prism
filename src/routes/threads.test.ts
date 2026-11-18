/**
 * Thread Routes Tests
 *
 * Covers the root-mounted endpoints that resolve and open threads:
 * GET /latest-thread, POST /threads (start a fresh thread) and GET /threads
 * (the resumable listing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockStartNewThread,
  mockListThreads,
  mockGetOrCreateLatestThread,
  mockGetGitBranch,
} = vi.hoisted(() => ({
  mockStartNewThread: vi.fn(),
  mockListThreads: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetGitBranch: vi.fn(),
}));

vi.mock('../services/conversation.service', () => ({
  conversationService: {
    startNewThread: mockStartNewThread,
    listThreads: mockListThreads,
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
  },
}));

vi.mock('../utils/git-branch', () => ({
  getGitBranch: mockGetGitBranch,
}));

// Override the global config mock with the fields this route reads.
vi.mock('../config', () => ({
  config: { agentId: 'test-agent-id', ownerUserId: 'owner-user-1' },
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { threadsRouter } from './threads';
import { config } from '../config';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mounted at the root (no prefix), matching server.ts.
  app.use(threadsRouter);
  return app;
}

describe('Thread Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.agentId = 'test-agent-id';
  });

  describe('GET /latest-thread', () => {
    it('returns the id of the latest thread', async () => {
      mockGetOrCreateLatestThread.mockResolvedValue({ id: 'latest-thread' });

      const res = await request(makeApp()).get('/latest-thread');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threadId: 'latest-thread' });
      expect(mockGetOrCreateLatestThread).toHaveBeenCalledWith('test-agent-id', 'owner-user-1');
    });

    it('returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).get('/latest-thread');

      expect(res.status).toBe(503);
      expect(mockGetOrCreateLatestThread).not.toHaveBeenCalled();
    });
  });

  describe('POST /threads', () => {
    it('starts a new active thread and returns its id', async () => {
      mockStartNewThread.mockResolvedValue({ id: 'thread-fresh' });

      const res = await request(makeApp()).post('/threads');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threadId: 'thread-fresh' });
      expect(mockStartNewThread).toHaveBeenCalledWith(
        'test-agent-id',
        'owner-user-1',
        undefined,
      );
    });

    it('forwards a workspaceRoot from the request body', async () => {
      mockStartNewThread.mockResolvedValue({ id: 'thread-fresh' });

      const res = await request(makeApp())
        .post('/threads')
        .send({ workspaceRoot: '/home/me/project' });

      expect(res.status).toBe(200);
      expect(mockStartNewThread).toHaveBeenCalledWith('test-agent-id', 'owner-user-1', {
        workspaceRoot: '/home/me/project',
      });
    });

    it('ignores an empty / whitespace-only workspaceRoot', async () => {
      mockStartNewThread.mockResolvedValue({ id: 'thread-fresh' });

      await request(makeApp()).post('/threads').send({ workspaceRoot: '   ' });

      expect(mockStartNewThread).toHaveBeenCalledWith(
        'test-agent-id',
        'owner-user-1',
        undefined,
      );
    });

    it('returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).post('/threads');

      expect(res.status).toBe(503);
      expect(mockStartNewThread).not.toHaveBeenCalled();
    });

    it('returns 500 when the service throws', async () => {
      mockStartNewThread.mockRejectedValue(new Error('db down'));

      const res = await request(makeApp()).post('/threads');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db down');
    });
  });

  describe('GET /threads', () => {
    it('lists resumable threads newest-first with a git-branch label, one git lookup per unique root', async () => {
      mockListThreads.mockResolvedValue([
        { id: 'thread-new', title: 'Deploy Staging', updatedAt: '2026-06-16T10:00:00.000Z', workspaceRoot: '/repo/a' },
        // Same repo as thread-new → must NOT spawn a second git lookup.
        { id: 'thread-dup', title: null, updatedAt: '2026-06-16T09:30:00.000Z', workspaceRoot: '/repo/a' },
        { id: 'thread-old', title: null, updatedAt: '2026-06-16T09:00:00.000Z', workspaceRoot: null },
      ]);
      mockGetGitBranch.mockResolvedValue('worktree/feature');

      const res = await request(makeApp()).get('/threads');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 'thread-new',
          title: 'Deploy Staging',
          updatedAt: '2026-06-16T10:00:00.000Z',
          workspaceRoot: '/repo/a',
          branch: 'worktree/feature',
          // These threads carry no stored context snapshot, so there is no
          // percentage to report for them.
          contextUsage: null,
        },
        {
          id: 'thread-dup',
          title: null,
          updatedAt: '2026-06-16T09:30:00.000Z',
          workspaceRoot: '/repo/a',
          branch: 'worktree/feature',
          contextUsage: null,
        },
        {
          id: 'thread-old',
          title: null,
          updatedAt: '2026-06-16T09:00:00.000Z',
          workspaceRoot: null,
          branch: null,
          contextUsage: null,
        },
      ]);
      // Resumable threads only via threadSource DATABASE, capped at 50;
      // ordering is the service's responsibility.
      expect(mockListThreads).toHaveBeenCalledWith('owner-user-1', 'test-agent-id', {
        threadSource: 'DATABASE',
        limit: 50,
      });
      // One git lookup per *unique* workspace root: /repo/a is shared by two
      // threads (one lookup) and thread-old has none (no lookup).
      expect(mockGetGitBranch).toHaveBeenCalledTimes(1);
      expect(mockGetGitBranch).toHaveBeenCalledWith('/repo/a');
    });

    it('lists only the threads of the folder a client asks for, so the limit counts those', async () => {
      mockListThreads.mockResolvedValue([]);

      await request(makeApp()).get('/threads').query({ workspaceRoot: '/repo/a' });

      expect(mockListThreads).toHaveBeenCalledWith('owner-user-1', 'test-agent-id', {
        threadSource: 'DATABASE',
        limit: 50,
        workspaceRoot: '/repo/a',
      });
    });

    it('includes a derived context percentage for threads that have run a turn', async () => {
      mockListThreads.mockResolvedValue([
        {
          id: 'thread-used',
          title: 'Big refactor',
          updatedAt: '2026-06-16T10:00:00.000Z',
          workspaceRoot: null,
          contextTokens: 600_000,
          contextModel: 'us.anthropic.claude-opus-5',
        },
      ]);

      const res = await request(makeApp()).get('/threads');

      expect(res.status).toBe(200);
      expect(res.body[0].contextUsage).toEqual({
        threadId: 'thread-used',
        modelId: 'us.anthropic.claude-opus-5',
        usedTokens: 600_000,
        windowTokens: 1_000_000,
        usedPercent: 60,
      });
    });

    it('survives rows where the context columns are absent rather than null', async () => {
      // Regression: a `=== null` guard let undefined through and threw a
      // TypeError deep in the ID normalizer, turning the whole listing into a 500.
      mockListThreads.mockResolvedValue([
        { id: 'thread-bare', title: null, updatedAt: '2026-06-16T10:00:00.000Z', workspaceRoot: null },
      ]);

      const res = await request(makeApp()).get('/threads');

      expect(res.status).toBe(200);
      expect(res.body[0].contextUsage).toBeNull();
    });

    it('returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).get('/threads');

      expect(res.status).toBe(503);
      expect(mockListThreads).not.toHaveBeenCalled();
    });
  });
});
