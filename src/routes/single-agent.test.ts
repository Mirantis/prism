/**
 * Single-Agent Routes Tests
 *
 * Covers POST /single-agent/threads — the endpoint the CLI hits on open to
 * start a fresh conversation thread.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockStartNewThread, mockListThreads, mockResumeThread, mockGetGitBranch } =
  vi.hoisted(() => ({
    mockStartNewThread: vi.fn(),
    mockListThreads: vi.fn(),
    mockResumeThread: vi.fn(),
    mockGetGitBranch: vi.fn(),
  }));

vi.mock('../services/conversation.service', () => ({
  conversationService: {
    startNewThread: mockStartNewThread,
    listThreads: mockListThreads,
    resumeThread: mockResumeThread,
    getOrCreateLatestThread: vi.fn(),
    getRecentMessages: vi.fn(),
  },
}));

vi.mock('../utils/git-branch', () => ({
  getGitBranch: mockGetGitBranch,
}));

vi.mock('../services/attachment.service', () => ({
  attachmentService: {
    attachMetaToMessages: vi.fn(async (m: unknown) => m),
  },
}));

// Override the global config mock with the fields this route reads.
vi.mock('../config', () => ({
  config: { agentId: 'test-agent-id', ownerUserId: 'owner-user-1' },
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { singleAgentRouter } from './single-agent';
import { config } from '../config';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/single-agent', singleAgentRouter);
  return app;
}

describe('Single-Agent Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.agentId = 'test-agent-id';
  });

  describe('POST /single-agent/threads', () => {
    it('starts a new active thread and returns its id', async () => {
      mockStartNewThread.mockResolvedValue({ id: 'thread-fresh' });

      const res = await request(makeApp()).post('/single-agent/threads');

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
        .post('/single-agent/threads')
        .send({ workspaceRoot: '/home/me/project' });

      expect(res.status).toBe(200);
      expect(mockStartNewThread).toHaveBeenCalledWith('test-agent-id', 'owner-user-1', {
        workspaceRoot: '/home/me/project',
      });
    });

    it('ignores an empty / whitespace-only workspaceRoot', async () => {
      mockStartNewThread.mockResolvedValue({ id: 'thread-fresh' });

      await request(makeApp()).post('/single-agent/threads').send({ workspaceRoot: '   ' });

      expect(mockStartNewThread).toHaveBeenCalledWith(
        'test-agent-id',
        'owner-user-1',
        undefined,
      );
    });

    it('returns 503 when single-agent mode is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).post('/single-agent/threads');

      expect(res.status).toBe(503);
      expect(mockStartNewThread).not.toHaveBeenCalled();
    });

    it('returns 500 when the service throws', async () => {
      mockStartNewThread.mockRejectedValue(new Error('db down'));

      const res = await request(makeApp()).post('/single-agent/threads');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db down');
    });
  });

  describe('GET /single-agent/threads', () => {
    it('lists resumable threads newest-first with a git-branch label', async () => {
      mockListThreads.mockResolvedValue([
        { id: 'thread-new', updatedAt: '2026-06-16T10:00:00.000Z', workspaceRoot: '/repo/a' },
        { id: 'thread-old', updatedAt: '2026-06-16T09:00:00.000Z', workspaceRoot: null },
      ]);
      mockGetGitBranch.mockResolvedValue('worktree/feature');

      const res = await request(makeApp()).get('/single-agent/threads');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 'thread-new',
          updatedAt: '2026-06-16T10:00:00.000Z',
          workspaceRoot: '/repo/a',
          branch: 'worktree/feature',
        },
        {
          id: 'thread-old',
          updatedAt: '2026-06-16T09:00:00.000Z',
          workspaceRoot: null,
          branch: null,
        },
      ]);
      // Resumable only (externalThreadId:null), capped at 50; ordering is the
      // service's responsibility.
      expect(mockListThreads).toHaveBeenCalledWith('owner-user-1', 'test-agent-id', {
        excludeExternal: true,
        limit: 50,
      });
      // Branch is only looked up for threads that have a workspace root.
      expect(mockGetGitBranch).toHaveBeenCalledTimes(1);
      expect(mockGetGitBranch).toHaveBeenCalledWith('/repo/a');
    });

    it('returns 503 when single-agent mode is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).get('/single-agent/threads');

      expect(res.status).toBe(503);
      expect(mockListThreads).not.toHaveBeenCalled();
    });
  });

  describe('POST /single-agent/threads/:threadId/resume', () => {
    it('resumes a thread and returns its id', async () => {
      mockResumeThread.mockResolvedValue({ id: 'thread-resumed' });

      const res = await request(makeApp()).post('/single-agent/threads/thread-resumed/resume');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threadId: 'thread-resumed' });
      expect(mockResumeThread).toHaveBeenCalledWith(
        'test-agent-id',
        'owner-user-1',
        'thread-resumed',
      );
    });

    it('returns 404 when the thread does not exist / is not owned', async () => {
      mockResumeThread.mockResolvedValue(null);

      const res = await request(makeApp()).post('/single-agent/threads/nope/resume');

      expect(res.status).toBe(404);
    });

    it('returns 503 when single-agent mode is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).post('/single-agent/threads/x/resume');

      expect(res.status).toBe(503);
      expect(mockResumeThread).not.toHaveBeenCalled();
    });
  });
});
