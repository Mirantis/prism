/**
 * Activity Route Tests
 *
 * The two read endpoints behind the Activity page: how each one reads its query
 * parameters, and that a failing read becomes a 500 rather than an unhandled
 * rejection. The arithmetic itself is covered in the service's own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockLlmUsage, mockToolCalls } = vi.hoisted(() => ({
  mockLlmUsage: vi.fn(),
  mockToolCalls: vi.fn(),
}));

vi.mock('../services/llm-usage.service', () => ({
  llmUsageService: { summarize: mockLlmUsage },
}));
vi.mock('../services/tool-call-history.service', () => ({
  toolCallHistoryService: { page: mockToolCalls },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { activityRouter } from './activity';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', activityRouter);
  return app;
}

const SUMMARY = {
  windowHours: 24,
  totalTokens: 2200,
  inputTokens: 2000,
  outputTokens: 200,
  cacheReadTokens: 1400,
  cacheWriteTokens: 200,
  noCacheTokens: 400,
  cacheHitPercent: 70,
  calls: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLlmUsage.mockResolvedValue(SUMMARY);
  mockToolCalls.mockResolvedValue({ items: [], nextCursor: null });
});

describe('GET /agents/activity/llm-usage', () => {
  it('defaults to a 24-hour window', async () => {
    const res = await request(createTestApp()).get('/agents/activity/llm-usage');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUMMARY);
    expect(mockLlmUsage).toHaveBeenCalledWith(24);
  });

  it('honours an explicit window', async () => {
    await request(createTestApp()).get('/agents/activity/llm-usage?hours=168');

    expect(mockLlmUsage).toHaveBeenCalledWith(168);
  });

  it('rejects a window outside 1..the month cap', async () => {
    const app = createTestApp();

    for (const query of ['hours=0', 'hours=-5', 'hours=abc', 'hours=', 'hours=999999']) {
      const res = await request(app).get(`/agents/activity/llm-usage?${query}`);
      expect(res.status).toBe(400);
    }
    expect(mockLlmUsage).not.toHaveBeenCalled();

    await request(app).get(`/agents/activity/llm-usage?hours=${24 * 31}`);
    expect(mockLlmUsage).toHaveBeenLastCalledWith(24 * 31);
  });

  it('maps a failing read to a 500', async () => {
    mockLlmUsage.mockRejectedValue(new Error('database is locked'));

    const res = await request(createTestApp()).get('/agents/activity/llm-usage');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'database is locked' });
  });
});

describe('GET /agents/activity/tool-calls', () => {
  it('defaults to 30 calls and no cursor', async () => {
    const res = await request(createTestApp()).get('/agents/activity/tool-calls');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(mockToolCalls).toHaveBeenCalledWith(30, undefined);
  });

  it('passes the limit and the cursor through', async () => {
    await request(createTestApp()).get('/agents/activity/tool-calls?limit=5&cursor=msg-1%3A2');

    expect(mockToolCalls).toHaveBeenCalledWith(5, 'msg-1:2');
  });

  it('rejects a page size over the cap', async () => {
    const res = await request(createTestApp()).get('/agents/activity/tool-calls?limit=5000');

    expect(res.status).toBe(400);
    expect(mockToolCalls).not.toHaveBeenCalled();
  });

  it('takes a page size at the cap', async () => {
    await request(createTestApp()).get('/agents/activity/tool-calls?limit=200');

    expect(mockToolCalls).toHaveBeenCalledWith(200, undefined);
  });

  it('treats an empty cursor as absent', async () => {
    await request(createTestApp()).get('/agents/activity/tool-calls?cursor=');

    expect(mockToolCalls).toHaveBeenCalledWith(30, undefined);
  });

  it('returns the page the service built', async () => {
    mockToolCalls.mockResolvedValue({
      items: [
        {
          id: 'msg-1-tc-0',
          tool: 'shell_exec',
          input: '{"command":"ls"}',
          output: '"a.txt"',
          success: true,
          timestamp: '2026-08-27T09:00:00.000Z',
          messageId: 'msg-1',
          threadId: 'thread-1',
          threadTitle: 'A thread',
          triggeredBy: 'USER_INPUT',
        },
      ],
      nextCursor: 'msg-1:0',
    });

    const res = await request(createTestApp()).get('/agents/activity/tool-calls');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].tool).toBe('shell_exec');
    expect(res.body.nextCursor).toBe('msg-1:0');
  });

  it('maps a failing read to a 500', async () => {
    mockToolCalls.mockRejectedValue(new Error('nope'));

    const res = await request(createTestApp()).get('/agents/activity/tool-calls');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'nope' });
  });
});
