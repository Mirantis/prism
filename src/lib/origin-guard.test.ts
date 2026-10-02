/**
 * Origin Guard Tests
 *
 * The rule under test: a request with no `Origin` is allowed (every non-browser
 * client), a request stating this server's own origin, a loopback one or one
 * `PRISM_ALLOWED_ORIGINS` lists is allowed, and every other stated origin is
 * refused.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { config } from '../config';
import { isAllowedOrigin, originGuard } from './origin-guard';
import { type OriginPattern, parseOriginPatterns } from './origin-patterns';

// The rules differ by what the server is bound to, so each test says which.
const boundTo = (host: string) => {
  (config as unknown as { host: string }).host = host;
};

// The configured `PRISM_ALLOWED_ORIGINS`, empty unless a test sets it.
const allowing = (csv: string) => {
  (config as unknown as { allowedOrigins: OriginPattern[] }).allowedOrigins =
    parseOriginPatterns(csv);
};

describe('isAllowedOrigin', () => {
  afterEach(() => boundTo('127.0.0.1'));

  it('allows a request that states no origin', () => {
    expect(isAllowedOrigin(undefined, 'localhost:3003')).toBe(true);
  });

  it('allows loopback origins, whatever the port', () => {
    for (const origin of [
      'http://localhost:3003',
      'http://localhost:5173',
      'http://127.0.0.1:3003',
      'http://127.0.0.2:9999',
      'http://[::1]:3003',
      'https://LocalHost:3003',
    ]) {
      expect(isAllowedOrigin(origin, 'localhost:3003'), origin).toBe(true);
    }
  });

  it('allows an origin matching the request host once the bind is widened', () => {
    boundTo('0.0.0.0');
    expect(isAllowedOrigin('http://192.168.1.5:3003', '192.168.1.5:3003')).toBe(true);
    expect(isAllowedOrigin('http://Agent.Internal:3003', 'agent.internal:3003')).toBe(true);
  });

  it('refuses a foreign host while the bind is loopback, matching origin or not', () => {
    // DNS rebinding: the attacker's page and the request name one host, which
    // resolves to 127.0.0.1, so the browser treats the runtime as same-origin.
    expect(isAllowedOrigin('http://evil.example:3003', 'evil.example:3003')).toBe(false);
    // The same request without an origin — a rebound same-origin GET.
    expect(isAllowedOrigin(undefined, 'evil.example:3003')).toBe(false);
    expect(isAllowedOrigin('http://localhost:3003', 'evil.example:3003')).toBe(false);
  });

  it('allows a request that states no host', () => {
    expect(isAllowedOrigin(undefined, undefined)).toBe(true);
    expect(isAllowedOrigin('http://localhost:3003', undefined)).toBe(true);
  });

  it('refuses an unparseable host', () => {
    expect(isAllowedOrigin(undefined, 'not a host')).toBe(false);
  });

  it('accepts a bracketed IPv6 loopback host', () => {
    expect(isAllowedOrigin('http://[::1]:3003', '[::1]:3003')).toBe(true);
  });

  it('refuses two origin headers joined into one value', () => {
    expect(isAllowedOrigin('http://localhost:3003, https://evil.example', 'localhost:3003')).toBe(
      false,
    );
  });

  it('refuses a foreign origin', () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example:3003',
      // A hostname that merely contains a loopback name is a different host.
      'http://notlocalhost',
      'http://localhost.evil.example',
      // The literal a sandboxed page sends, and anything else unparseable.
      'null',
      'not a url',
    ]) {
      expect(isAllowedOrigin(origin, 'localhost:3003'), origin).toBe(false);
    }
  });

  it('refuses an origin on another port of the same non-loopback host', () => {
    boundTo('0.0.0.0');
    expect(isAllowedOrigin('http://192.168.1.5:8080', '192.168.1.5:3003')).toBe(false);
  });

  it('allows an origin matching X-Forwarded-Host once a proxy rewrote the host', () => {
    // The hosted shape: the platform router addresses the runtime by an
    // internal name and forwards the browser's host separately.
    boundTo('0.0.0.0');
    expect(
      isAllowedOrigin('https://web.platform.example', 'runtime:3003', 'web.platform.example'),
    ).toBe(true);
    expect(
      isAllowedOrigin('https://Web.Platform.Example', 'runtime:3003', 'web.platform.example'),
    ).toBe(true);
  });

  it('matches only the first X-Forwarded-Host value', () => {
    boundTo('0.0.0.0');
    expect(
      isAllowedOrigin(
        'https://web.platform.example',
        'runtime:3003',
        'web.platform.example, runtime:3003',
      ),
    ).toBe(true);
    expect(
      isAllowedOrigin(
        'https://evil.example',
        'runtime:3003',
        'web.platform.example, evil.example',
      ),
    ).toBe(false);
  });

  it('refuses a foreign origin whatever X-Forwarded-Host says elsewhere', () => {
    boundTo('0.0.0.0');
    expect(isAllowedOrigin('https://evil.example', 'runtime:3003', 'web.platform.example')).toBe(
      false,
    );
    expect(isAllowedOrigin('https://web.platform.example', 'runtime:3003', undefined)).toBe(false);
  });

  it('allows a Host-preserving proxy in front of the loopback bind', () => {
    // Caddy, ngrok and tailscale serve forward the inbound `Host` to
    // 127.0.0.1 unchanged. `X-Forwarded-Host` is what marks the proxy: a
    // browser cannot state that header, so a rebinding page cannot either.
    // A webhook sender states no `Origin`.
    expect(isAllowedOrigin(undefined, 'agent.example.com', 'agent.example.com')).toBe(true);
    // The Web UI through the same proxy.
    expect(
      isAllowedOrigin('https://agent.example.com', 'agent.example.com', 'agent.example.com'),
    ).toBe(true);
    // A foreign origin is still held to rule 2.
    expect(
      isAllowedOrigin('https://evil.example', 'agent.example.com', 'agent.example.com'),
    ).toBe(false);
  });

  it('keeps rebinding refused at the loopback bind without X-Forwarded-Host', () => {
    expect(isAllowedOrigin('http://evil.example:3003', 'evil.example:3003')).toBe(false);
    // An empty header counts as absent.
    expect(isAllowedOrigin(undefined, 'evil.example:3003', '')).toBe(false);
  });
});

describe('isAllowedOrigin with PRISM_ALLOWED_ORIGINS', () => {
  afterEach(() => {
    boundTo('127.0.0.1');
    allowing('');
  });

  it('allows a listed origin behind a proxy that rewrote the host', () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com:*');
    expect(
      isAllowedOrigin('https://app.example.com:53224', 'runtime:3003', 'agent.platform.example'),
    ).toBe(true);
    expect(isAllowedOrigin('https://app.example.com', 'runtime:3003')).toBe(true);
  });

  it('still refuses an unlisted foreign origin', () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com');
    expect(isAllowedOrigin('https://evil.example', 'runtime:3003', 'agent.platform.example')).toBe(
      false,
    );
    expect(isAllowedOrigin('https://app.example.com:8443', 'runtime:3003')).toBe(false);
    expect(isAllowedOrigin('null', 'runtime:3003')).toBe(false);
  });

  it('keeps rebinding refused at the loopback bind without X-Forwarded-Host', () => {
    allowing('https://app.example.com');
    expect(isAllowedOrigin('https://app.example.com', 'app.example.com')).toBe(false);
    // The proxy header is what lets network traffic in at a loopback bind.
    expect(isAllowedOrigin('https://app.example.com', 'app.example.com', 'app.example.com')).toBe(
      true,
    );
  });
});

describe('originGuard', () => {
  const runGuard = (origin?: string) => {
    const req = { headers: { origin, host: 'localhost:3003' }, method: 'POST', path: '/agents/chat' };
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }), json };
    const next = vi.fn();
    originGuard(req as unknown as Request, res as unknown as Response, next as NextFunction);
    return { next, res, json };
  };

  it('calls next for an allowed origin', () => {
    const { next, res } = runGuard('http://localhost:3003');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 403 for a foreign origin and does not call next', () => {
    const { next, res, json } = runGuard('https://evil.example');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden origin' });
  });
});

describe('originGuard CORS headers', () => {
  afterEach(() => {
    boundTo('127.0.0.1');
    allowing('');
  });

  const app = () => {
    const server = express();
    server.use(originGuard);
    server.all('/probe', (_req, res) => {
      res.json({ ok: true });
    });
    return server;
  };

  it('names a listed origin in Access-Control-Allow-Origin and varies on Origin', async () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com:*');
    const res = await request(app())
      .get('/probe')
      .set('Host', 'runtime:3003')
      .set('Origin', 'https://app.example.com:4444');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com:4444');
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('adds no CORS headers for a same-host origin, listed or not', async () => {
    boundTo('0.0.0.0');
    allowing('https://agent.example.com');
    const res = await request(app())
      .get('/probe')
      .set('Host', 'agent.example.com')
      .set('Origin', 'https://agent.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
  });

  it('adds no CORS headers for an unlisted loopback origin', async () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com');
    const res = await request(app())
      .get('/probe')
      .set('Host', 'runtime:3003')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
  });

  it('names a listed loopback origin, so that page can read the response', async () => {
    boundTo('0.0.0.0');
    allowing('http://localhost:*');
    const res = await request(app())
      .get('/probe')
      .set('Host', 'runtime:3003')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers.vary).toBe('Origin');
  });

  it('answers the preflight of a listed origin with 204', async () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com');
    const res = await request(app())
      .options('/probe')
      .set('Host', 'runtime:3003')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('passes an OPTIONS request that is not a preflight to the routes', async () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com');
    const res = await request(app())
      .options('/probe')
      .set('Host', 'runtime:3003')
      .set('Origin', 'https://app.example.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('answers 403 with no CORS headers to an unlisted origin and its preflight', async () => {
    boundTo('0.0.0.0');
    allowing('https://app.example.com');
    for (const method of ['get', 'options'] as const) {
      const res = await request(app())
        [method]('/probe')
        .set('Host', 'runtime:3003')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status, method).toBe(403);
      expect(res.headers['access-control-allow-origin'], method).toBeUndefined();
    }
  });
});
