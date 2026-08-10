/**
 * Message Routes Tests
 *
 * Covers GET /messages — thread history replay, optionally pinned to a
 * specific thread via ?threadId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockGetOwnedThreadId,
  mockGetOrCreateLatestThread,
  mockGetRecentMessages,
} = vi.hoisted(() => ({
  mockGetOwnedThreadId: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetRecentMessages: vi.fn(),
}));

vi.mock('../services/conversation.service', () => ({
  conversationService: {
    getOwnedThreadId: mockGetOwnedThreadId,
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
    getRecentMessages: mockGetRecentMessages,
  },
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

import { messagesRouter } from './messages';
import { config } from '../config';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mounted at the root (no prefix), matching server.ts.
  app.use(messagesRouter);
  return app;
}

describe('Message Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.agentId = 'test-agent-id';
  });

  describe('GET /messages', () => {
    it('replays the latest thread when no threadId is given', async () => {
      mockGetOrCreateLatestThread.mockResolvedValue({ id: 'latest-thread' });
      mockGetRecentMessages.mockResolvedValue([]);

      const res = await request(makeApp()).get('/messages?limit=10');

      expect(res.status).toBe(200);
      expect(mockGetOwnedThreadId).not.toHaveBeenCalled();
      expect(mockGetOrCreateLatestThread).toHaveBeenCalledWith('test-agent-id', 'owner-user-1');
      expect(mockGetRecentMessages).toHaveBeenCalledWith('latest-thread', 10);
    });

    it('replays a specific, ownership-checked thread when threadId is given', async () => {
      // Cheap ownership check returns the id (no message load) — not getThread.
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockGetRecentMessages.mockResolvedValue([]);

      const res = await request(makeApp()).get('/messages?threadId=thread-x');

      expect(res.status).toBe(200);
      expect(mockGetOwnedThreadId).toHaveBeenCalledWith('owner-user-1', 'test-agent-id', 'thread-x');
      expect(mockGetRecentMessages).toHaveBeenCalledWith('thread-x', 50);
      expect(mockGetOrCreateLatestThread).not.toHaveBeenCalled();
    });

    it('returns 404 when the requested thread is not owned / does not exist', async () => {
      mockGetOwnedThreadId.mockResolvedValue(null);

      const res = await request(makeApp()).get('/messages?threadId=nope');

      expect(res.status).toBe(404);
      expect(mockGetRecentMessages).not.toHaveBeenCalled();
    });

    it('returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await request(makeApp()).get('/messages');

      expect(res.status).toBe(503);
      expect(mockGetRecentMessages).not.toHaveBeenCalled();
    });
  });
});
