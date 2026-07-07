/**
 * Inbound Webhook Route Tests
 *
 * Status-code mapping for POST /agents/webhooks/:name and the
 * fire-and-forget contract (the route answers without awaiting the agent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockHandleInbound, mockTrackEvent } = vi.hoisted(() => ({
  mockHandleInbound: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../services/webhook.service', () => ({
  webhookService: {
    handleInbound: mockHandleInbound,
  },
}));

vi.mock('../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { webhookRouter } from './webhook';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', webhookRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /agents/webhooks/:name', () => {
  it('400s non-object bodies', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/agents/webhooks/alerts')
      .set('content-type', 'application/json')
      .send('[1,2]');
    expect(res.status).toBe(400);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('403s when the receiver is disabled', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'receiver_disabled' });
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/receiver is disabled/i);
  });

  it('404s unknown subscriptions', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'not_found' });
    const res = await request(createTestApp()).post('/agents/webhooks/nope').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
  });

  it('403s disabled subscriptions', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'subscription_disabled' });
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('429s when the subscription run queue is full', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'busy' });
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/queue is full/i);
  });

  it('200s filtered events with the resolved type', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'ignored', event: 'push' });
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored', event: 'push' });
  });

  it('200s deliver-only subscriptions synchronously', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'delivered', event: 'unknown' });
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'delivered', event: 'unknown' });
  });

  it('202s agent-mode runs with a runId', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'accepted', event: 'unknown' });
    const res = await request(createTestApp())
      .post('/agents/webhooks/alerts')
      .send({ status: 'firing' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.runId).toBeTruthy();
    // The runId in the response is the one handed to the service.
    expect(mockHandleInbound).toHaveBeenCalledWith(
      'alerts',
      { status: 'firing' },
      expect.any(Object),
      res.body.runId,
    );
  });

  it('emits one webhook received event per delivery with the gate outcome', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'ignored', event: 'push' });
    await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'webhook received',
      null,
      expect.objectContaining({ 'webhook.outcome': 'filtered' }),
    );
  });

  it('500s when the service throws', async () => {
    mockHandleInbound.mockRejectedValue(new Error('db exploded'));
    const res = await request(createTestApp()).post('/agents/webhooks/alerts').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db exploded');
  });
});
