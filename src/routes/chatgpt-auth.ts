/**
 * Sign in with ChatGPT routes (`/agents/chatgpt-auth/*`).
 *
 * Mounted under `/agents` in `src/server.ts`:
 *   GET  /agents/chatgpt-auth/status   — { enabled, signedIn, email, expiresAt }
 *   POST /agents/chatgpt-auth/start    — { authorizeUrl, state }
 *   GET  /agents/chatgpt-auth/callback — OAuth 2.0 PKCE browser callback
 *   POST /agents/chatgpt-auth/sign-out — clears stored tokens
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { ChatGptAuthError, chatGptAuthService } from '../services/chatgpt-auth.service';

export const chatGptAuthRouter = Router();

const CALLBACK_PATH = '/agents/chatgpt-auth/callback';

function callbackUrlFor(req: Request): string {
  if (config.publicUrl) {
    return `${config.publicUrl}${CALLBACK_PATH}`;
  }
  const host = req.get('host') || `127.0.0.1:${config.port}`;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${host}${CALLBACK_PATH}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCallbackPage(title: string, message: string, ok: boolean): string {
  const accent = ok ? '#15803d' : '#b91c1c';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.25rem; color: #111827; line-height: 1.5; }
    h1 { font-size: 1.25rem; color: ${accent}; margin-bottom: 0.5rem; }
    p { color: #374151; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function singleQueryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

chatGptAuthRouter.get('/chatgpt-auth/status', (_req: Request, res: Response) => {
  res.json(chatGptAuthService.status());
});

chatGptAuthRouter.post('/chatgpt-auth/start', async (req: Request, res: Response) => {
  try {
    const result = await chatGptAuthService.startSignIn(callbackUrlFor(req));
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, '[ChatGptAuth] Failed to start sign-in');
    res.status(500).json({ error: 'Could not start Sign in with ChatGPT.' });
  }
});

chatGptAuthRouter.get('/chatgpt-auth/callback', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.type('html');
  try {
    const status = await chatGptAuthService.handleCallback({
      code: singleQueryString(req.query.code),
      state: singleQueryString(req.query.state),
      clientId: singleQueryString(req.query.client_id),
      error: singleQueryString(req.query.error),
      errorDescription: singleQueryString(req.query.error_description),
    });
    const who = status.email ? ` as ${status.email}` : '';
    res.status(200).send(
      renderCallbackPage('Signed in to ChatGPT', `Prism is now connected${who}. You can close this tab.`, true),
    );
  } catch (err) {
    const statusCode = err instanceof ChatGptAuthError ? err.statusCode : 500;
    const message = err instanceof ChatGptAuthError ? err.message : 'Sign in with ChatGPT failed. Try again.';
    logger.warn({ err, statusCode }, '[ChatGptAuth] Callback failed');
    res.status(statusCode).send(renderCallbackPage('ChatGPT sign-in failed', message, false));
  }
});

chatGptAuthRouter.post('/chatgpt-auth/sign-out', async (_req: Request, res: Response) => {
  try {
    res.json(await chatGptAuthService.signOut());
  } catch (err) {
    logger.error({ err }, '[ChatGptAuth] Sign-out failed');
    res.status(500).json({ error: 'Sign-out failed. Try again.' });
  }
});
