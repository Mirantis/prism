/**
 * Webhook Sender Authentication Tests
 *
 * The verifier is provider-agnostic, so the cases are organized by *scheme*
 * (token / hmac) and parameter, with a final block that reproduces the
 * real-world recipes from docs/webhooks.md purely as configuration — digests
 * are computed independently here, never taken from the implementation.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  isValidAuthAlgorithm,
  isValidAuthEncoding,
  isValidAuthType,
  verifyWebhookAuth,
  WEBHOOK_AUTH_TYPES,
} from './webhook-signature';

const SECRET = 's3cret';
const BODY = '{"action":"opened","number":7}';

/** Minimal config; each test overrides what it exercises. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    authType: 'none',
    secret: null,
    authHeader: null,
    authPrefix: null,
    authAlgorithm: 'sha256',
    authEncoding: 'hex',
    headers: {},
    rawBody: Buffer.from(BODY, 'utf8'),
    ...overrides,
  } as Parameters<typeof verifyWebhookAuth>[0];
}

function hmac(body: string, secret = SECRET, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') {
  return crypto.createHmac(algorithm, secret).update(Buffer.from(body, 'utf8')).digest(encoding);
}

describe('validators', () => {
  it('accepts only the generic auth types', () => {
    expect(WEBHOOK_AUTH_TYPES).toEqual(['none', 'token', 'hmac']);
    expect(isValidAuthType('hmac')).toBe(true);
    // No provider names: those are configuration, not types.
    expect(isValidAuthType('github')).toBe(false);
    expect(isValidAuthType(undefined)).toBe(false);
  });

  it('accepts the supported digests and encodings', () => {
    expect(isValidAuthAlgorithm('sha512')).toBe(true);
    expect(isValidAuthAlgorithm('md5')).toBe(false);
    expect(isValidAuthEncoding('base64')).toBe(true);
    expect(isValidAuthEncoding('base64url')).toBe(false);
  });
});

describe("authType 'none'", () => {
  it('passes without looking at anything', () => {
    expect(verifyWebhookAuth(config())).toBe('ok');
  });

  it('passes even with no raw body captured', () => {
    expect(verifyWebhookAuth(config({ rawBody: undefined }))).toBe('ok');
  });
});

describe('misconfiguration fails closed', () => {
  it('rejects a scheme with no secret', () => {
    expect(
      verifyWebhookAuth(config({ authType: 'token', authHeader: 'X-Token', secret: null })),
    ).toBe('misconfigured');
    expect(
      verifyWebhookAuth(config({ authType: 'token', authHeader: 'X-Token', secret: '   ' })),
    ).toBe('misconfigured');
  });

  it('rejects a scheme with no header configured', () => {
    expect(verifyWebhookAuth(config({ authType: 'hmac', secret: SECRET, authHeader: null }))).toBe(
      'misconfigured',
    );
  });

  it('rejects an unknown scheme, digest or encoding', () => {
    expect(
      verifyWebhookAuth(config({ authType: 'magic', secret: SECRET, authHeader: 'X-Token' })),
    ).toBe('misconfigured');
    expect(
      verifyWebhookAuth(
        config({ authType: 'hmac', secret: SECRET, authHeader: 'X-Sig', authAlgorithm: 'md5' }),
      ),
    ).toBe('misconfigured');
    expect(
      verifyWebhookAuth(
        config({ authType: 'hmac', secret: SECRET, authHeader: 'X-Sig', authEncoding: 'rot13' }),
      ),
    ).toBe('misconfigured');
  });
});

describe("authType 'token'", () => {
  const base = { authType: 'token', secret: SECRET, authHeader: 'X-Token' };

  it('accepts the secret verbatim, case-insensitive header lookup', () => {
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-token': SECRET } }))).toBe('ok');
    expect(
      verifyWebhookAuth(config({ ...base, authHeader: 'X-TOKEN', headers: { 'x-token': SECRET } })),
    ).toBe('ok');
  });

  it('accepts a repeated header by its first value', () => {
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-token': [SECRET, 'other'] } }))).toBe(
      'ok',
    );
  });

  it('rejects a wrong, empty or absent token', () => {
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-token': 'nope' } }))).toBe('invalid');
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-token': '' } }))).toBe('invalid');
    expect(verifyWebhookAuth(config({ ...base, headers: {} }))).toBe('invalid');
  });

  it('rejects a token that merely starts with the secret', () => {
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-token': `${SECRET}extra` } }))).toBe(
      'invalid',
    );
  });

  it('strips a configured prefix, and tolerates its absence', () => {
    const withPrefix = { ...base, authHeader: 'Authorization', authPrefix: 'Bearer ' };
    expect(
      verifyWebhookAuth(config({ ...withPrefix, headers: { authorization: `Bearer ${SECRET}` } })),
    ).toBe('ok');
    // A bare credential still matches — the prefix is optional on the wire.
    expect(verifyWebhookAuth(config({ ...withPrefix, headers: { authorization: SECRET } }))).toBe(
      'ok',
    );
    expect(
      verifyWebhookAuth(config({ ...withPrefix, headers: { authorization: `Basic ${SECRET}` } })),
    ).toBe('invalid');
  });

  it("matches whether or not the configured prefix ends in a space", () => {
    // Operators write 'Bearer' as often as 'Bearer '; the space between prefix
    // and credential is stripped either way, so both configurations work and
    // the UI doesn't have to teach a whitespace rule.
    for (const authPrefix of ['Bearer', 'Bearer ']) {
      expect(
        verifyWebhookAuth(
          config({
            ...base,
            authHeader: 'Authorization',
            authPrefix,
            headers: { authorization: `Bearer ${SECRET}` },
          }),
        ),
      ).toBe('ok');
    }
  });

  it('does not split on commas, so a secret may contain one', () => {
    const comma = 'part-a,part-b';
    expect(
      verifyWebhookAuth(config({ ...base, secret: comma, headers: { 'x-token': comma } })),
    ).toBe('ok');
    expect(
      verifyWebhookAuth(config({ ...base, secret: comma, headers: { 'x-token': 'part-a' } })),
    ).toBe('invalid');
  });
});

describe("authType 'hmac'", () => {
  const base = { authType: 'hmac', secret: SECRET, authHeader: 'X-Signature' };

  it('accepts a digest over the exact received bytes', () => {
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': hmac(BODY) } })),
    ).toBe('ok');
  });

  it('rejects a digest over re-serialized (differently spaced) JSON', () => {
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': hmac(reserialized) } })),
    ).toBe('invalid');
  });

  it('rejects a digest made with another secret, and a tampered body', () => {
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': hmac(BODY, 'other') } })),
    ).toBe('invalid');
    expect(
      verifyWebhookAuth(
        config({
          ...base,
          headers: { 'x-signature': hmac(BODY) },
          rawBody: Buffer.from('{"action":"closed"}', 'utf8'),
        }),
      ),
    ).toBe('invalid');
  });

  it('rejects when no raw body was captured', () => {
    expect(
      verifyWebhookAuth(
        config({ ...base, headers: { 'x-signature': hmac(BODY) }, rawBody: undefined }),
      ),
    ).toBe('invalid');
  });

  it('rejects a truncated digest without throwing on the length mismatch', () => {
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': hmac(BODY).slice(0, 20) } })),
    ).toBe('invalid');
  });

  it('accepts hex in either case but is strict about base64', () => {
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': hmac(BODY).toUpperCase() } })),
    ).toBe('ok');
    const b64 = { ...base, authEncoding: 'base64' };
    expect(
      verifyWebhookAuth(
        config({ ...b64, headers: { 'x-signature': hmac(BODY, SECRET, 'sha256', 'base64') } }),
      ),
    ).toBe('ok');
    expect(
      verifyWebhookAuth(
        config({
          ...b64,
          headers: { 'x-signature': hmac(BODY, SECRET, 'sha256', 'base64').toLowerCase() },
        }),
      ),
    ).toBe('invalid');
  });

  it('supports sha1 and sha512 digests', () => {
    for (const algorithm of ['sha1', 'sha512'] as const) {
      expect(
        verifyWebhookAuth(
          config({
            ...base,
            authAlgorithm: algorithm,
            headers: { 'x-signature': hmac(BODY, SECRET, algorithm) },
          }),
        ),
      ).toBe('ok');
      // The digest must match the configured algorithm, not just any of them.
      expect(
        verifyWebhookAuth(
          config({ ...base, authAlgorithm: algorithm, headers: { 'x-signature': hmac(BODY) } }),
        ),
      ).toBe('invalid');
    }
  });

  it('accepts any candidate in a comma-separated header (secret rotation)', () => {
    const header = `v1=${hmac(BODY, 'old-secret')},v1=${hmac(BODY)}`;
    expect(
      verifyWebhookAuth(config({ ...base, authPrefix: 'v1=', headers: { 'x-signature': header } })),
    ).toBe('ok');
  });

  it('rejects a comma-separated header where nothing matches', () => {
    const header = `v1=${hmac(BODY, 'old')},v1=${hmac(BODY, 'older')}`;
    expect(
      verifyWebhookAuth(config({ ...base, authPrefix: 'v1=', headers: { 'x-signature': header } })),
    ).toBe('invalid');
  });

  it('ignores empty candidates from stray commas', () => {
    expect(
      verifyWebhookAuth(config({ ...base, headers: { 'x-signature': `,,${hmac(BODY)},` } })),
    ).toBe('ok');
    expect(verifyWebhookAuth(config({ ...base, headers: { 'x-signature': ',,,' } }))).toBe(
      'invalid',
    );
  });

  it('strips the configured prefix from the digest', () => {
    const withPrefix = { ...base, authPrefix: 'sha256=' };
    expect(
      verifyWebhookAuth(
        config({ ...withPrefix, headers: { 'x-signature': `sha256=${hmac(BODY)}` } }),
      ),
    ).toBe('ok');
    expect(
      verifyWebhookAuth(
        config({ ...withPrefix, headers: { 'x-signature': `sha1=${hmac(BODY)}` } }),
      ),
    ).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// The documented recipes — every real sender is configuration, not code.
// ---------------------------------------------------------------------------

describe('documented sender recipes', () => {
  it('verifies a GitHub-style signature (hmac, X-Hub-Signature-256, sha256=)', () => {
    expect(
      verifyWebhookAuth(
        config({
          authType: 'hmac',
          secret: SECRET,
          authHeader: 'X-Hub-Signature-256',
          authPrefix: 'sha256=',
          headers: { 'x-hub-signature-256': `sha256=${hmac(BODY)}` },
        }),
      ),
    ).toBe('ok');
  });

  it('verifies a PagerDuty-style multi-signature header (hmac, v1=)', () => {
    expect(
      verifyWebhookAuth(
        config({
          authType: 'hmac',
          secret: SECRET,
          authHeader: 'X-PagerDuty-Signature',
          authPrefix: 'v1=',
          headers: { 'x-pagerduty-signature': `v1=${hmac(BODY, 'rotated-out')},v1=${hmac(BODY)}` },
        }),
      ),
    ).toBe('ok');
  });

  it('verifies a GitLab-style secret token (token, X-Gitlab-Token, no prefix)', () => {
    expect(
      verifyWebhookAuth(
        config({
          authType: 'token',
          secret: SECRET,
          authHeader: 'X-Gitlab-Token',
          headers: { 'x-gitlab-token': SECRET },
        }),
      ),
    ).toBe('ok');
  });

  it('verifies an Alertmanager-style bearer token (token, Authorization, Bearer )', () => {
    expect(
      verifyWebhookAuth(
        config({
          authType: 'token',
          secret: SECRET,
          authHeader: 'Authorization',
          authPrefix: 'Bearer ',
          headers: { authorization: `Bearer ${SECRET}` },
        }),
      ),
    ).toBe('ok');
  });

  it('verifies a base64 HMAC sender (hmac, base64)', () => {
    expect(
      verifyWebhookAuth(
        config({
          authType: 'hmac',
          secret: SECRET,
          authHeader: 'X-Sender-Hmac-Sha256',
          authEncoding: 'base64',
          headers: { 'x-sender-hmac-sha256': hmac(BODY, SECRET, 'sha256', 'base64') },
        }),
      ),
    ).toBe('ok');
  });
});
