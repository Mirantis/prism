/**
 * Locked-In Mode Route Tests
 *
 * PATCH /agents/locked-in: the persisted write, body validation, and error
 * mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetAgent, mockPrisma } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockPrisma: {
    agentWorkspace: {
      update: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: vi.fn(),
  isTelemetryEnabled: () => false,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Keep the real service (so `updateLockedIn` and `ValidationError` are the real
// implementations) and redirect `getAgent` to the controllable mock.
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

import { lockedInRouter } from './locked-in';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', lockedInRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /agents/locked-in', () => {
  it('flips the lockedIn flag on the agent row', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', lockedIn: false });
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', lockedIn: true });

    const res = await request(createTestApp()).patch('/agents/locked-in').send({ lockedIn: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lockedIn: true });
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { lockedIn: true },
    });
  });

  // The lock must be liftable from the UI while it is on — otherwise a locked
  // agent would be locked forever.
  it('unlocks again while locked', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', lockedIn: true });
    mockPrisma.agentWorkspace.update.mockResolvedValue({ id: 'agent-1', lockedIn: false });

    const res = await request(createTestApp()).patch('/agents/locked-in').send({ lockedIn: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lockedIn: false });
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { lockedIn: false },
    });
  });

  it('rejects a non-boolean lockedIn without writing', async () => {
    const res = await request(createTestApp()).patch('/agents/locked-in').send({ lockedIn: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('boolean');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('returns 400 when lockedIn is missing without writing', async () => {
    const res = await request(createTestApp()).patch('/agents/locked-in').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('lockedIn');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('returns 500 when Prisma update throws', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', lockedIn: false });
    mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('DB error'));

    const res = await request(createTestApp()).patch('/agents/locked-in').send({ lockedIn: true });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB error');
  });
});
