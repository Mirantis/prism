import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const { mockHandleInbound } = vi.hoisted(() => ({ mockHandleInbound: vi.fn() }));

vi.mock('./services/webhook.service', () => ({
  webhookService: { handleInbound: mockHandleInbound },
}));

import { createApp } from './server';
import { createWebhookApp } from './services/webhook-receiver.service';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'agent-runtime',
    });
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('webhook deliveries', () => {
  it('reach the webhook listener with the bytes the sender sent', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'delivered', event: 'push' });
    const body = '{ "ref":  "main" }';

    const res = await request(createWebhookApp())
      .post('/agents/webhooks/alerts')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(mockHandleInbound.mock.calls[0][0]).toBe('alerts');
    expect((mockHandleInbound.mock.calls[0][4] as Buffer).toString('utf8')).toBe(body);
  });

  it('are not served on the main port', async () => {
    const res = await request(createApp()).post('/agents/webhooks/alerts').send({});

    expect(res.status).toBe(404);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });

  it('share their listener with no management route', async () => {
    const app = createWebhookApp();

    expect((await request(app).get('/agents/webhook-subscriptions')).status).toBe(404);
    expect((await request(app).get('/agents/webhooks/receiver')).status).toBe(404);
    expect((await request(app).get('/health')).status).toBe(404);
  });

  it('are refused from a browser page on another site', async () => {
    const res = await request(createWebhookApp())
      .post('/agents/webhooks/alerts')
      .set('origin', 'https://attacker.example')
      .send({});

    expect(res.status).toBe(403);
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });
});
