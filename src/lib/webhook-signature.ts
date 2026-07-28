/**
 * Webhook Sender Authentication
 *
 * Single owner of "did this inbound webhook really come from its sender?".
 *
 *   'none'  — no verification (default; auth is the platform's job)
 *   'token' — `authHeader` must carry `secret` verbatim, after an optional
 *             literal `authPrefix` ('Bearer', …)
 *   'hmac'  — `authHeader` must carry HMAC(secret, raw body) in `authAlgorithm`
 *             + `authEncoding`, after an optional literal `authPrefix`
 *             ('sha256=', 'v1=', …)
 *
 * In 'hmac' mode the header value is split on ',' and any matching candidate
 * passes, which is what makes senders that emit several signatures during a
 * secret rotation work without the code knowing whose convention that is.
 * 'token' mode compares the whole value, so a secret containing a comma is
 * safe.
 */

import crypto from 'crypto';

export const WEBHOOK_AUTH_TYPES = ['none', 'token', 'hmac'] as const;
export type WebhookAuthType = (typeof WEBHOOK_AUTH_TYPES)[number];

export const WEBHOOK_AUTH_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const;
export type WebhookAuthAlgorithm = (typeof WEBHOOK_AUTH_ALGORITHMS)[number];

export const WEBHOOK_AUTH_ENCODINGS = ['hex', 'base64'] as const;
export type WebhookAuthEncoding = (typeof WEBHOOK_AUTH_ENCODINGS)[number];

export function isValidAuthType(value: unknown): value is WebhookAuthType {
  return typeof value === 'string' && (WEBHOOK_AUTH_TYPES as readonly string[]).includes(value);
}

export function isValidAuthAlgorithm(value: unknown): value is WebhookAuthAlgorithm {
  return (
    typeof value === 'string' && (WEBHOOK_AUTH_ALGORITHMS as readonly string[]).includes(value)
  );
}

export function isValidAuthEncoding(value: unknown): value is WebhookAuthEncoding {
  return typeof value === 'string' && (WEBHOOK_AUTH_ENCODINGS as readonly string[]).includes(value);
}

/**
 * Verification outcome. 'invalid' is the sender's fault (bad/absent
 * credential), 'misconfigured' is ours (a subscription demands verification but
 * lacks the secret or header to do it). Both reject — the distinction only
 * shapes the log line, never the HTTP response.
 */
export type WebhookAuthOutcome = 'ok' | 'invalid' | 'misconfigured';

export interface WebhookAuthConfig {
  authType: string;
  secret: string | null;
  authHeader: string | null;
  authPrefix: string | null;
  authAlgorithm: string;
  authEncoding: string;
}

export interface WebhookAuthInput extends WebhookAuthConfig {
  headers: Record<string, string | string[] | undefined>;
  /** Exact received bytes (lib/raw-body.ts); required for 'hmac'. */
  rawBody: Buffer | undefined;
}

/** First value of a header, normalized the way resolveEventType() does. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name.trim().toLowerCase()];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

/** Constant-time string equality that tolerates differing lengths. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on unequal lengths; compare against a same-length
  // copy so the answer is still "false" without leaking via an exception.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Strip `prefix` if present; the credential may also arrive bare. */
function stripPrefix(value: string, prefix: string | null): string {
  if (!prefix) return value;
  return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
}

/**
 * Verify one inbound delivery against a subscription's auth configuration.
 * Never throws: an unexpected shape is a rejection.
 */
export function verifyWebhookAuth(input: WebhookAuthInput): WebhookAuthOutcome {
  const { authType, secret, authHeader, authPrefix, authAlgorithm, authEncoding } = input;

  // Configuration first, so a broken subscription reads as 'misconfigured'
  // whatever the request happens to carry.
  if (authType === 'none') return 'ok';
  if (!isValidAuthType(authType)) return 'misconfigured';
  if (!secret || !secret.trim()) return 'misconfigured';
  if (!authHeader || !authHeader.trim()) return 'misconfigured';

  let algorithm: WebhookAuthAlgorithm = 'sha256';
  let encoding: WebhookAuthEncoding = 'hex';
  if (authType === 'hmac') {
    if (!isValidAuthAlgorithm(authAlgorithm) || !isValidAuthEncoding(authEncoding)) {
      return 'misconfigured';
    }
    algorithm = authAlgorithm;
    encoding = authEncoding;
  }

  const received = headerValue(input.headers, authHeader);
  if (!received) return 'invalid';

  if (authType === 'token') {
    return timingSafeEqualStr(stripPrefix(received, authPrefix), secret) ? 'ok' : 'invalid';
  }

  // 'hmac' — the digest must be computed over the exact received bytes.
  const rawBody = input.rawBody;
  if (!rawBody) return 'invalid';

  const digest = crypto.createHmac(algorithm, secret).update(rawBody).digest(encoding);
  // Hex is case-insensitive and senders disagree on case; base64 is not.
  const normalize = (value: string) => (encoding === 'hex' ? value.toLowerCase() : value);
  const expected = normalize(digest);

  // Any candidate may match: senders rotating a secret send several signatures
  // in one comma-separated header.
  return received
    .split(',')
    .map((candidate) => normalize(stripPrefix(candidate.trim(), authPrefix)))
    .some((candidate) => candidate.length > 0 && timingSafeEqualStr(candidate, expected))
    ? 'ok'
    : 'invalid';
}
