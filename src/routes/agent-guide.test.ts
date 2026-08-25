/**
 * Agent Guide Route Tests
 *
 * PATCH /agents/agent-guide: the persisted write, body validation, the
 * telemetry event, and error mapping. The route is the only write path for
 * `agentMd`, and it stays open while locked-in mode is on — that lock covers
 * the agent's own tools, not the user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetAgent, mockPrisma, mockTrackEvent } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockPrisma: {
    agentWorkspace: {
      update: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Keep the real service (so `updateAgentGuide` and `ValidationError` are the
// real implementations) and redirect `getAgent` to the controllable mock.
vi.mock('../services/agent-workspace.service', async () => {
  const actual = await vi.importActual<typeof import('../services/agent-workspace.service')>(
    '../services/agent-workspace.service',
  );
  (actual.agentWorkspaceService as unknown as { getAgent: typeof mockGetAgent }).getAgent =
    mockGetAgent;
  return actual;
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { agentGuideRouter } from './agent-guide';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', agentGuideRouter);
  return app;
}

const GUIDE = '# Agent Guide\n\n- Ship small changes.\n';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', agentMd: 'old guide' });
});

describe('PATCH /agents/agent-guide', () => {
  it('replaces agentMd and returns the stored document', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', agentMd: GUIDE });

    const res = await request(createTestApp())
      .patch('/agents/agent-guide')
      .send({ agentMd: GUIDE });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agentMd: GUIDE });
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { agentMd: GUIDE },
    });
  });

  // Clearing the document is a real edit, not a validation error: an empty
  // guide drops the `# Agent Guide` section from the prompt.
  it('accepts an empty document', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', agentMd: '' });

    const res = await request(createTestApp()).patch('/agents/agent-guide').send({ agentMd: '' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agentMd: '' });
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { agentMd: '' },
    });
  });

  // The write is user-owned, so the lock that withholds the agent's document
  // tools must not shut the user out of their own editor.
  it('writes while locked-in mode is on', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', lockedIn: true });
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', agentMd: GUIDE });

    const res = await request(createTestApp())
      .patch('/agents/agent-guide')
      .send({ agentMd: GUIDE });

    expect(res.status).toBe(200);
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalled();
  });

  it('emits "agent config updated" naming the field and the REST path', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', agentMd: GUIDE });

    await request(createTestApp()).patch('/agents/agent-guide').send({ agentMd: GUIDE });

    expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
      'agent.id': 'agent-1',
      'config.field': 'agentMd',
      'config.method': 'rest',
    });
  });

  it('rejects a non-string agentMd without writing', async () => {
    const res = await request(createTestApp())
      .patch('/agents/agent-guide')
      .send({ agentMd: { text: 'nope' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('string');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('returns 400 when agentMd is missing without writing', async () => {
    const res = await request(createTestApp()).patch('/agents/agent-guide').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agentMd');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('emits no telemetry when the write is rejected', async () => {
    await request(createTestApp()).patch('/agents/agent-guide').send({ agentMd: 42 });

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns 500 when Prisma update throws', async () => {
    mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('DB error'));

    const res = await request(createTestApp())
      .patch('/agents/agent-guide')
      .send({ agentMd: GUIDE });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB error');
  });
});
