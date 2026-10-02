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
 * 2. **A stated `Origin` must be loopback, the host the browser addressed, or
 *    one `PRISM_ALLOWED_ORIGINS` lists.** The addressed host is the request's
 *    own `Host`, or the first `X-Forwarded-Host` value when a proxy rewrote
 *    `Host` on the way in; that is what serves the Web UI of a deliberately
 *    widened runtime, hosted deployments included. The list admits a web app on
 *    another site, and only a runtime behind an authenticating proxy may set it
 *    (`config.ts` refuses it on a loopback bind). Rule 1 runs first, whatever
 *    the list holds.
 *
 * A request stating no `Origin` passes rule 2. That is every non-browser client
 * — the terminal UI, `curl`, a webhook sender — and a browser states the header
 * on the cross-origin requests these rules are about.
 *
 * An HTTP request from a listed origin other than the addressed host gets
 * `Access-Control-Allow-Origin` naming its origin, so the page can read the
 * response; a same-site page needs no such header. The guard runs
 * ahead of every route and body parser, so error responses have it too. It
 * also answers that origin's CORS preflight, which a proxy in front may
 * answer first.
 *
 * Trusting `X-Forwarded-Host` keeps the browser rules intact: a browser cannot
 * state that header itself — the WebSocket API sends no custom headers, and a
 * fetch that adds one fails its CORS preflight — and a non-browser client
 * already passes by stating no `Origin`.
 */

import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { isLoopbackHostname } from './loopback-host';
import { matchesOrigin } from './origin-patterns';

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

/** `listed` when `PRISM_ALLOWED_ORIGINS` admits an origin other than the addressed host. */
type Verdict = 'refused' | 'allowed' | 'listed';

function judge(
  origin: string | undefined,
  host: string | undefined,
  forwardedHost: string | string[] | undefined,
): Verdict {
  const forwarded = firstForwardedHost(forwardedHost);
  if (!isAllowedHost(host, forwarded)) return 'refused';
  if (!origin) return 'allowed';

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Includes the literal `null` a sandboxed page sends.
    return 'refused';
  }

  const stated = parsed.host.toLowerCase();
  if (host && stated === host.toLowerCase()) return 'allowed';
  if (forwarded && stated === forwarded.toLowerCase()) return 'allowed';
  // Ahead of the loopback rule, so a listed loopback page can read responses.
  if (matchesOrigin(config.allowedOrigins, origin)) return 'listed';
  return isLoopbackHostname(parsed.hostname) ? 'allowed' : 'refused';
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
  return judge(origin, host, forwardedHost) !== 'refused';
}

/**
 * Express middleware form: answers 403 to a request the rules refuse, and
 * gives a listed origin its CORS headers.
 */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const { origin } = req.headers;
  const verdict = judge(origin, req.headers.host, req.headers['x-forwarded-host']);
  if (verdict === 'allowed') {
    next();
    return;
  }
  if (verdict === 'listed' && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
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
