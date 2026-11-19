import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { config } from '../config';

const { mockService } = vi.hoisted(() => ({
  mockService: {
    status: vi.fn(),
    startSignIn: vi.fn(),
    handleCallback: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('../services/chatgpt-auth.service', async (original) => ({
  ...(await original<typeof import('../services/chatgpt-auth.service')>()),
  chatGptAuthService: mockService,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { chatGptAuthRouter } from './chatgpt-auth';
import { ChatGptAuthError } from '../services/chatgpt-auth.service';

const app = express();
app.use(express.json());
app.use('/agents', chatGptAuthRouter);

describe('chatgpt auth routes', () => {
  const originalPublicUrl = config.publicUrl;

  beforeEach(() => {
    config.publicUrl = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    config.publicUrl = originalPublicUrl;
  });

  it('returns auth status', async () => {
    const status = { enabled: true, signedIn: false, email: null, expiresAt: null };
    mockService.status.mockReturnValue(status);
    const res = await request(app).get('/agents/chatgpt-auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(status);
  });

  it('starts sign-in with callback URL derived from the request host and returns authorizeUrl only', async () => {
    mockService.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=abc',
    });
    const res = await request(app)
      .post('/agents/chatgpt-auth/start')
      .set('Host', '127.0.0.1:3003');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=abc',
    });
    expect(mockService.startSignIn).toHaveBeenCalledWith('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
  });

  it('uses first X-Forwarded-Host and X-Forwarded-Proto behind an HTTPS reverse proxy when publicUrl is unset', async () => {
    mockService.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=proxy',
    });
    const res = await request(app)
      .post('/agents/chatgpt-auth/start')
      .set('Host', '127.0.0.1:3003')
      .set('X-Forwarded-Host', 'prism.example.com, internal.proxy')
      .set('X-Forwarded-Proto', 'https, http');
    expect(res.status).toBe(201);
    expect(mockService.startSignIn).toHaveBeenCalledWith('https://prism.example.com/agents/chatgpt-auth/callback');
  });

  it('prefers config.publicUrl over forwarded headers', async () => {
    config.publicUrl = 'https://configured.example.com';
    mockService.startSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=pub',
    });
    const res = await request(app)
      .post('/agents/chatgpt-auth/start')
      .set('X-Forwarded-Host', 'ignored.example.com')
      .set('X-Forwarded-Proto', 'http');
    expect(res.status).toBe(201);
    expect(mockService.startSignIn).toHaveBeenCalledWith('https://configured.example.com/agents/chatgpt-auth/callback');
  });

  it('renders an HTML confirmation page on callback success', async () => {
    mockService.handleCallback.mockResolvedValue({
      enabled: true,
      signedIn: true,
      email: 'dev@example.com',
      expiresAt: Date.now() + 3600_000,
    });
    const res = await request(app).get(
      '/agents/chatgpt-auth/callback?code=c1&state=s1&client_id=oaiapp_1',
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.text).toContain('Signed in to ChatGPT');
    expect(res.text).toContain('dev@example.com');
  });

  it('escapes error text in HTML callback failures', async () => {
    mockService.handleCallback.mockRejectedValue(
      new ChatGptAuthError('<script>alert(1)</script>', 400),
    );
    const res = await request(app).get('/agents/chatgpt-auth/callback?state=bad');
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('signs out and returns updated status', async () => {
    const after = { enabled: true, signedIn: false, email: null, expiresAt: null };
    mockService.signOut.mockResolvedValue(after);
    const res = await request(app).post('/agents/chatgpt-auth/sign-out');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(after);
  });
});
