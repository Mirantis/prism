/**
 * Spending Route Tests
 *
 * How each endpoint reads its query parameters, and which status a bad parameter,
 * a missing thread or request and a failed read get. The sums are covered in the
 * service's own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockSpending, mockGetAgent } = vi.hoisted(() => ({
  mockSpending: { summary: vi.fn(), periods: vi.fn(), threads: vi.fn(), thread: vi.fn(), request: vi.fn(), sources: vi.fn() },
  mockGetAgent: vi.fn(),
}));

vi.mock('../services/spending.service', () => ({
  spendingService: mockSpending,
  SOURCED_CATEGORIES: ['scheduled-tasks', 'webhooks', 'goals'],
}));
vi.mock('../services/agent-workspace.service', () => ({ agentWorkspaceService: { getAgent: mockGetAgent } }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { spendingRouter } from './spending';

function app() {
  const server = express();
  server.use('/agents', spendingRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpending.summary.mockResolvedValue({ costUsd: 1.5 });
  mockSpending.periods.mockResolvedValue([]);
  mockSpending.threads.mockResolvedValue({ threads: [], nextOffset: null });
  mockGetAgent.mockResolvedValue({ timezone: 'Europe/Helsinki' });
});

describe('GET /agents/spending', () => {
  it('reads the range it is given', async () => {
    const res = await request(app()).get('/agents/spending?from=2026-11-01T00:00:00Z&to=2026-11-21T00:00:00Z');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z', costUsd: 1.5 });
    expect(mockSpending.summary).toHaveBeenCalledWith({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-21T00:00:00Z'),
    });
  });

  it('defaults to the 30 days before now', async () => {
    const res = await request(app()).get('/agents/spending');

    const { from, to } = mockSpending.summary.mock.calls[0][0];
    expect(res.status).toBe(200);
    expect(to.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ['from=yesterday', 'from must be an ISO 8601 time'],
    ['from=2026-11-21T00:00:00Z&to=2026-11-01T00:00:00Z', 'from must be before to'],
  ])('refuses %s', async (query, error) => {
    const res = await request(app()).get(`/agents/spending?${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });

  it('answers 500 when the read fails', async () => {
    mockSpending.summary.mockRejectedValue(new Error('database is locked'));

    expect((await request(app()).get('/agents/spending')).status).toBe(500);
  });
});

describe('GET /agents/spending/periods', () => {
  it("lists 30 days in the agent's own time zone by default", async () => {
    const res = await request(app()).get('/agents/spending/periods');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ period: 'day', timezone: 'Europe/Helsinki', periods: [] });
    expect(mockSpending.periods).toHaveBeenCalledWith('day', 30, 'Europe/Helsinki');
  });

  it('takes the period, the count and a time zone', async () => {
    await request(app()).get('/agents/spending/periods?period=month&count=6&timezone=America/New_York');

    expect(mockSpending.periods).toHaveBeenCalledWith('month', 6, 'America/New_York');
  });

  it.each([
    ['period=year', 'period must be day, week or month'],
    ['period=week&count=105', 'count must be an integer in 1..104'],
    ['count=0', 'count must be an integer in 1..366'],
    ['timezone=Mars/Olympus', 'timezone must be an IANA time zone name'],
  ])('refuses %s', async (query, error) => {
    const res = await request(app()).get(`/agents/spending/periods?${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });
});

describe('GET /agents/spending/threads', () => {
  it('pages with limit and offset', async () => {
    const res = await request(app()).get('/agents/spending/threads?limit=10&offset=20');

    expect(res.status).toBe(200);
    expect(mockSpending.threads).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(Date) }), 10, 20);
  });

  it('refuses a page size above 200', async () => {
    expect((await request(app()).get('/agents/spending/threads?limit=201')).status).toBe(400);
  });
});

describe('GET /agents/spending/sources', () => {
  it('reads one category over the range', async () => {
    mockSpending.sources.mockResolvedValue([]);
    const res = await request(app()).get('/agents/spending/sources?category=webhooks&from=2026-11-01T00:00:00Z&to=2026-11-21T00:00:00Z');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ category: 'webhooks', from: '2026-11-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z', sources: [] });
    expect(mockSpending.sources).toHaveBeenCalledWith('webhooks', {
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-21T00:00:00Z'),
    });
  });

  it('refuses a category that has no sources', async () => {
    const res = await request(app()).get('/agents/spending/sources?category=voice');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'category must be one of scheduled-tasks, webhooks, goals' });
  });
});

describe('one thread and one request', () => {
  it('answers what the service read', async () => {
    mockSpending.thread.mockResolvedValue({ threadId: 'thread-1', costUsd: 0.2, requests: [] });
    mockSpending.request.mockResolvedValue({ requestId: 'message-1', costUsd: 0.1 });

    expect((await request(app()).get('/agents/spending/threads/thread-1')).body).toMatchObject({ threadId: 'thread-1' });
    expect((await request(app()).get('/agents/spending/requests/message-1')).body).toMatchObject({ requestId: 'message-1' });
    expect(mockSpending.thread).toHaveBeenCalledWith('thread-1');
    expect(mockSpending.request).toHaveBeenCalledWith('message-1');
  });

  it('answers 404 for one with no spending', async () => {
    mockSpending.thread.mockResolvedValue(null);
    mockSpending.request.mockResolvedValue(null);

    expect((await request(app()).get('/agents/spending/threads/nothing')).status).toBe(404);
    expect((await request(app()).get('/agents/spending/requests/nothing')).status).toBe(404);
  });
});
