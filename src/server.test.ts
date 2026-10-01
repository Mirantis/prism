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

  it('accepts a delivery forwarded by a tunnel with its public Host', async () => {
    mockHandleInbound.mockResolvedValue({ status: 'delivered', event: 'push' });
    const res = await request(createWebhookApp())
      .post('/agents/webhooks/alerts')
      .set('host', 'hooks.example.com')
      .send({});
    expect(res.status).toBe(200);
  });

  it('rejects simple cross-site form posts and provides no CORS preflight permission', async () => {
    const app = createWebhookApp();
    const preflight = await request(app).options('/agents/webhooks/alerts')
      .set('origin', 'https://sender.example')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await request(app).post('/agents/webhooks/alerts')
        .set('origin', 'https://sender.example').set('content-type', type).send('{}');
      expect(res.status).toBe(400);
    }
    expect(mockHandleInbound).not.toHaveBeenCalled();
  });
});
