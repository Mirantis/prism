import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockIsAgentIdle } = vi.hoisted(() => ({ mockIsAgentIdle: vi.fn() }));

vi.mock('../services/agent-activity', () => ({ isAgentIdle: mockIsAgentIdle }));

import { agentStateRouter } from './agent-state';

const app = express();
app.use('/agents', agentStateRouter);

describe('GET /agents/state', () => {
  it('says working while the agent has work in flight', async () => {
    mockIsAgentIdle.mockResolvedValue(false);

    const res = await request(app).get('/agents/state');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'working' });
  });

  it('says idle when nothing runs or waits', async () => {
    mockIsAgentIdle.mockResolvedValue(true);

    expect((await request(app).get('/agents/state')).body).toEqual({ state: 'idle' });
  });
});
