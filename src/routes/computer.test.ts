/**
 * The endpoint that answers a sign-in the agent asked for.
 *
 * What matters here is what reaches the browser and what the user is told when it does
 * not: a request that is no longer waiting, one of any other kind, and each way the
 * typing can fail all leave the request open and say so, and only a sign-in that went in
 * resolves it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockSignIn, mockList, mockContinueRequest, mockStatus } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockList: vi.fn(),
  mockContinueRequest: vi.fn(),
  mockStatus: vi.fn(() => ({ available: true })),
}));

vi.mock('../services/computer/computer.service', () => ({
  computerService: {
    signIn: mockSignIn,
    status: mockStatus,
    access: { stop: vi.fn() },
    takeControl: vi.fn(),
    handBack: vi.fn(),
  },
}));

vi.mock('../services/computer/computer-help.service', () => ({
  computerHelpService: { list: mockList, continueRequest: mockContinueRequest },
}));

vi.mock('../config', () => ({
  config: { agentId: 'agent-1', ownerUserId: 'user-1' },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { computerRouter } from './computer';

const HELP_ID = '00000000-0000-4000-8000-000000000001';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', computerRouter);
  return app;
}

function signInRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: 'computer_help',
    id: HELP_ID,
    reason: 'Sign in to the inbox',
    credentials: true,
    site: 'https://mail.example.com',
    targetId: 'target-1',
    status: 'waiting',
    ...overrides,
  };
}

const credentials = { username: 'demo-user', password: 'a-password' };

function post(body: unknown) {
  return request(createTestApp())
    .post(`/agents/computer/help/${HELP_ID}/credentials`)
    .send(body as object);
}

describe('answering a sign-in request', () => {
  beforeEach(() => {
    mockList.mockResolvedValue([signInRequest()]);
    mockSignIn.mockResolvedValue('filled');
    mockContinueRequest.mockResolvedValue(undefined);
  });

  it('types it into the browser and resolves the request', async () => {
    const response = await post(credentials);

    expect(response.status).toBe(200);
    expect(mockSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ id: HELP_ID, site: 'https://mail.example.com' }),
      credentials,
      'user-1',
      'agent-1',
    );
    expect(mockContinueRequest).toHaveBeenCalledWith('agent-1', 'user-1', HELP_ID, 'continue');
  });

  it('needs a password', async () => {
    const response = await post({ username: 'demo-user' });

    expect(response.status).toBe(400);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('refuses a request that has already been answered', async () => {
    mockList.mockResolvedValue([signInRequest({ status: 'continued' })]);

    const response = await post(credentials);

    expect(response.status).toBe(409);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('refuses a request of any other kind', async () => {
    mockList.mockResolvedValue([signInRequest({ credentials: undefined, site: undefined })]);

    const response = await post(credentials);

    expect(response.status).toBe(409);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ['site_changed', 'another site'],
    ['no_form', 'no sign-in form'],
    ['tab_gone', 'has closed'],
    ['in_use', 'control of the computer'],
  ])('leaves the request waiting when the typing answers %s', async (outcome, told) => {
    mockSignIn.mockResolvedValue(outcome);

    const response = await post(credentials);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain(told);
    expect(mockContinueRequest).not.toHaveBeenCalled();
  });
});
