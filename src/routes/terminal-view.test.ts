import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../lib/telemetry', () => ({ trackEvent }));
vi.mock('../config', () => ({ config: { ownerUserId: 'demo-user' } }));
import { terminalViewRouter } from './terminal-view';

const app = express();
app.use(express.json());
app.use('/agents', terminalViewRouter);
beforeEach(() => { trackEvent.mockClear(); });

it('records terminal view start and terminal outcomes without free-text properties', async () => {
  await request(app).post('/agents/terminal-view/events').send({ event: 'started', elapsedMs: 0, text: 'private draft' }).expect(204);
  for (const status of ['success', 'error']) {
    await request(app).post('/agents/terminal-view/events').send({ event: 'finished', status, elapsedMs: 1200 }).expect(204);
  }
  expect(trackEvent.mock.calls).toEqual([
    ['terminal web view started', 'demo-user', { renderer: 'kitty' }],
    ['terminal web view finished', 'demo-user', { renderer: 'kitty', status: 'success', elapsed_ms: '1200' }],
    ['terminal web view finished', 'demo-user', { renderer: 'kitty', status: 'error', elapsed_ms: '1200' }],
  ]);
});

it('rejects arbitrary event names and invalid terminal outcomes', async () => {
  for (const body of [{ event: 'arbitrary', elapsedMs: 0 }, { event: 'finished', elapsedMs: 0 }, { event: 'finished', status: 'error', elapsedMs: -1 }]) {
    await request(app).post('/agents/terminal-view/events').send(body).expect(400);
  }
  expect(trackEvent).not.toHaveBeenCalled();
});
