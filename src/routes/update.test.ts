/**
 * Update route tests: status pass-through, the 409/502 refusals, and the
 * happy path that answers before scheduling the restart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockService, MockUpdateInProgressError } = vi.hoisted(() => {
  class MockUpdateInProgressError extends Error {
    constructor() {
      super('An update is already in progress.');
    }
  }
  return {
    MockUpdateInProgressError,
    mockService: {
      getStatus: vi.fn(),
      checkNow: vi.fn(),
      startApply: vi.fn(),
      scheduleRestartExit: vi.fn(),
    },
  };
});

vi.mock('../services/update/update.service', () => ({
  updateService: mockService,
  UpdateInProgressError: MockUpdateInProgressError,
}));

import { updateRouter } from './update';

const app = express();
app.use(express.json());
app.use('/agents', updateRouter);

const CURRENT = 'v2026.8.20000000';
const NEWER = 'v2026.8.24083158';

function enabledStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    reason: null,
    currentVersion: CURRENT,
    latestVersion: NEWER,
    updateAvailable: true,
    checkedAt: null,
    applying: false,
    lastAttempt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /agents/update/status', () => {
  it('returns the service report', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    const res = await request(app).get('/agents/update/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, latestVersion: NEWER });
  });
});

describe('POST /agents/update', () => {
  it('409s when the updater is off', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus({ enabled: false, reason: 'dev_build' }));
    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('dev_build');
    expect(mockService.startApply).not.toHaveBeenCalled();
  });

  it('409s when an update is already in progress', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus({ applying: true }));
    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(409);
  });

  it('502s when the check cannot complete', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(null);
    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(502);
  });

  it('409s when already up to date', async () => {
    mockService.getStatus
      .mockResolvedValueOnce(enabledStatus({ updateAvailable: false, latestVersion: CURRENT }))
      .mockResolvedValueOnce(enabledStatus({ updateAvailable: false, latestVersion: CURRENT }));
    mockService.checkNow.mockResolvedValue(CURRENT);
    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('up to date');
  });

  it('answers 202 after the attempt is accepted and schedules the restart when it lands', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(NEWER);
    mockService.startApply.mockResolvedValue({
      version: NEWER,
      completion: Promise.resolve({ version: NEWER, willExit: true }),
    });

    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, version: NEWER });
    expect(mockService.startApply).toHaveBeenCalledWith(NEWER, 'MANUAL');
    // The completion resolves after the response; give its .then a turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockService.scheduleRestartExit).toHaveBeenCalled();
  });

  it('does not schedule an exit when the installer owns the restart (win32)', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(NEWER);
    mockService.startApply.mockResolvedValue({
      version: NEWER,
      completion: Promise.resolve({ version: NEWER, willExit: false }),
    });

    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockService.scheduleRestartExit).not.toHaveBeenCalled();
  });

  it('still answers 202 when the completion later fails (outcome rides WS + the attempt record)', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(NEWER);
    // Pre-handled: the mock rejects at creation, ticks before the route can
    // attach its catch — without this the runner reports it unhandled.
    const completion = Promise.reject(new Error('archive sha256 mismatch'));
    completion.catch(() => {});
    mockService.startApply.mockResolvedValue({ version: NEWER, completion });

    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockService.scheduleRestartExit).not.toHaveBeenCalled();
  });

  it('500s when accepting the attempt fails (nothing was recorded to poll for)', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(NEWER);
    mockService.startApply.mockRejectedValue(new Error('database is locked'));

    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('locked');
  });

  it('409s when an automatic apply won the race after the status check', async () => {
    mockService.getStatus.mockResolvedValue(enabledStatus());
    mockService.checkNow.mockResolvedValue(NEWER);
    mockService.startApply.mockRejectedValue(new MockUpdateInProgressError());

    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(409);
  });

  it('500s when the status read itself fails', async () => {
    mockService.getStatus.mockRejectedValue(new Error('db is locked'));
    const res = await request(app).post('/agents/update');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('locked');
  });
});
