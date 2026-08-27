/**
 * Which requests a browser may make to the runtime.
 *
 * Two rules, applied to the HTTP routes and to the `/api/ws` handshake alike —
 * a WebSocket handshake is exempt from the same-origin policy, so the check has
 * to be made here rather than left to the browser:
 *
 * 1. **The `Host` must name this machine while the bind is loopback**, unless
 *    the request states `X-Forwarded-Host` — a proxy in front, which is the one
 *    way network traffic legitimately arrives at a loopback bind. Without that
 *    header, a request naming another host arrived under a hostname that
 *    resolves here — the shape of a DNS rebinding attack, where the attacker's
 *    page and the request agree on a name so the browser treats the runtime as
 *    same-origin. A widened bind (`PRISM_HOST`) accepts any `Host`, since the
 *    exposed address is the operator's to choose.
 * 2. **A stated `Origin` must be loopback, or the host the browser addressed.**
 *    That host is the request's own `Host`, or the first `X-Forwarded-Host`
 *    value when a proxy rewrote `Host` on the way in. The rule is what serves
 *    the Web UI of a deliberately widened runtime, hosted deployments included.
 *
 * A request stating no `Origin` passes rule 2. That is every non-browser client
 * — the terminal UI, `curl`, a webhook sender — and a browser states the header
 * on the cross-origin requests these rules are about.
 *
 * Trusting `X-Forwarded-Host` keeps the browser rules intact: a browser cannot
 * state that header itself — the WebSocket API sends no custom headers, and a
 * fetch that adds one fails its CORS preflight — and a non-browser client
 * already passes by stating no `Origin`.
 */

import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase()) || IPV4_LOOPBACK.test(hostname);
}

/** The `Host` header is `hostname:port` with no scheme, and may hold `[::1]`. */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function isAllowedHost(host: string | undefined, forwardedHost: string | undefined): boolean {
  if (!isLoopbackHostname(config.host)) return true;
  // A proxy in front — the one way network traffic legitimately arrives at a
  // loopback bind. A browser cannot state the header, so rebinding stays closed.
  if (forwardedHost) return true;
  if (!host) return true;
  const hostname = hostnameOf(host);
  return hostname !== null && isLoopbackHostname(hostname);
}

/** First host in `X-Forwarded-Host`, which chained proxies join with commas. */
function firstForwardedHost(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(',')[0].trim() || undefined;
}

/**
 * `origin` is the request's `Origin` header, `host` its `Host` header, and
 * `forwardedHost` its `X-Forwarded-Host` header.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  forwardedHost?: string | string[],
): boolean {
  const forwarded = firstForwardedHost(forwardedHost);
  if (!isAllowedHost(host, forwarded)) return false;
  if (!origin) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Includes the literal `null` a sandboxed page sends.
    return false;
  }

  const stated = parsed.host.toLowerCase();
  if (host && stated === host.toLowerCase()) return true;
  if (forwarded && stated === forwarded.toLowerCase()) return true;
  return isLoopbackHostname(parsed.hostname);
}

/** Express middleware form: answers 403 to a request the rules refuse. */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (isAllowedOrigin(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])) {
    next();
    return;
  }

  logger.warn(
    '[OriginGuard] refused %s %s (origin %s, host %s, x-forwarded-host %s)',
    req.method,
    req.path,
    req.headers.origin,
    req.headers.host,
    req.headers['x-forwarded-host'],
  );
  res.status(403).json({ error: 'Forbidden origin' });
}
