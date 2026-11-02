/**
 * The coding agents' sign-in endpoints: what each answers, and that a code for
 * an attempt that is no longer waiting is refused rather than typed anywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { service } = vi.hoisted(() => ({
  service: { list: vi.fn(), start: vi.fn(), get: vi.fn(), submitCode: vi.fn(), signOut: vi.fn() },
}));

vi.mock('../services/coding-agent-sign-in/coding-agent-sign-in.service', async (original) => ({
  ...(await original<typeof import('../services/coding-agent-sign-in/coding-agent-sign-in.service')>()),
  codingAgentSignInService: service,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { codingAgentsRouter } from './coding-agents';
import { SignInClosedError, SignInUnavailableError } from '../services/coding-agent-sign-in/coding-agent-sign-in.service';

const app = express();
app.use(express.json());
app.use('/agents', codingAgentsRouter);

const attempt = { id: 'a1', agent: 'claude-code', status: 'waiting', url: 'https://claude.com/auth', userCode: null, expiresAt: 'x', error: null };

describe('coding agents routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the coding agents', async () => {
    service.list.mockResolvedValue([{ agent: 'codex' }]);
    const res = await request(app).get('/agents/coding-agents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [{ agent: 'codex' }] });
  });

  it('starts a sign-in', async () => {
    service.start.mockResolvedValue(attempt);
    const res = await request(app).post('/agents/coding-agents/claude-code/sign-in');
    expect(res.status).toBe(201);
    expect(res.body).toEqual(attempt);
    expect(service.start).toHaveBeenCalledWith('claude-code');
  });

  it('refuses an unknown coding agent', async () => {
    const res = await request(app).post('/agents/coding-agents/gemini/sign-in');
    expect(res.status).toBe(404);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('answers 409 when the CLI is not on this agent', async () => {
    service.start.mockRejectedValue(new SignInUnavailableError("Codex isn't available on this agent."));
    const res = await request(app).post('/agents/coding-agents/codex/sign-in');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Codex isn't available on this agent.");
  });

  it('reads an attempt, and 404s one that has ended', async () => {
    service.get.mockReturnValueOnce(attempt).mockReturnValueOnce(null);
    expect((await request(app).get('/agents/coding-agents/claude-code/sign-in/a1')).body).toEqual(attempt);
    expect((await request(app).get('/agents/coding-agents/claude-code/sign-in/old')).status).toBe(404);
  });

  it('passes the code to the sign-in', async () => {
    service.submitCode.mockResolvedValue({ ...attempt, status: 'signed_in' });
    const res = await request(app).post('/agents/coding-agents/claude-code/sign-in/a1/code').send({ code: ' the-code ' });
    expect(res.status).toBe(200);
    expect(service.submitCode).toHaveBeenCalledWith('a1', 'the-code');
  });

  it('refuses an empty code', async () => {
    const res = await request(app).post('/agents/coding-agents/claude-code/sign-in/a1/code').send({ code: '' });
    expect(res.status).toBe(400);
    expect(service.submitCode).not.toHaveBeenCalled();
  });

  it('answers 409 to a code for a closed sign-in', async () => {
    service.submitCode.mockRejectedValue(new SignInClosedError('That sign-in is closed. Get a new link.'));
    const res = await request(app).post('/agents/coding-agents/claude-code/sign-in/a1/code').send({ code: 'c' });
    expect(res.status).toBe(409);
  });

  it('takes no code for Codex, which the person types on OpenAI’s page', async () => {
    const res = await request(app).post('/agents/coding-agents/codex/sign-in/a1/code').send({ code: 'c' });
    expect(res.status).toBe(404);
  });

  it('signs out', async () => {
    service.signOut.mockResolvedValue({ agent: 'codex', subscription: false });
    const res = await request(app).post('/agents/coding-agents/codex/sign-out');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agent: 'codex', subscription: false });
  });
});
