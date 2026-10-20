/**
 * Model Selection Route Tests
 *
 * GET and PATCH /agents/model-selection: the shape a client reads, and the 400
 * that refuses Auto without a small and a large model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockGetAgent, mockPrisma } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockPrisma: { agentWorkspace: { update: vi.fn() } },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: vi.fn(),
  isTelemetryEnabled: () => false,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../services/agent-workspace.service', async () => {
  const actual = await vi.importActual<typeof import('../services/agent-workspace.service')>(
    '../services/agent-workspace.service',
  );
  (actual.agentWorkspaceService as unknown as { getAgent: typeof mockGetAgent }).getAgent = mockGetAgent;
  return actual;
});

import { modelSelectionRouter } from './model-selection';

const UNSET = { modelMode: null, smallModel: null, mediumModel: null, largeModel: null };

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', modelSelectionRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: 'agent-1', ...UNSET });
  mockPrisma.agentWorkspace.update.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'agent-1',
    ...UNSET,
    ...data,
  }));
});

describe('GET /agents/model-selection', () => {
  it('reads Fixed with no tiers on an agent that set nothing', async () => {
    const res = await request(createTestApp()).get('/agents/model-selection');

    expect(res.status).toBe(200);
    expect(res.body.mode).toEqual({ override: null, effective: 'fixed' });
    expect(res.body.tiers.small).toEqual({ override: null, effective: null });
  });
});

describe('PATCH /agents/model-selection', () => {
  it('turns Auto on with a small and a large model', async () => {
    const res = await request(createTestApp())
      .patch('/agents/model-selection')
      .send({ mode: 'auto', small: 'small-model', large: 'large-model' });

    expect(res.status).toBe(200);
    expect(res.body.mode.effective).toBe('auto');
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { modelMode: 'AUTO', smallModel: 'small-model', largeModel: 'large-model' },
    });
  });

  it('answers 400 for Auto without a small and a large model', async () => {
    const res = await request(createTestApp()).patch('/agents/model-selection').send({ mode: 'auto' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Auto mode needs a small and a large model');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed model id', async () => {
    const res = await request(createTestApp()).patch('/agents/model-selection').send({ small: 'bad id!' });

    expect(res.status).toBe(400);
  });
});
