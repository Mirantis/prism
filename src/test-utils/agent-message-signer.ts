/**
 * Signs agent message deliveries as the delivery service does, with a key made
 * for this run: an ES256 compact JWT in `x-agent-message-signature`, for one
 * agent and the SHA-256 of the exact body (`docs/agent-messages.md`).
 */

import crypto from 'crypto';

export interface DeliveryClaims {
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  sha256: string;
}

export interface TestDeliverySigner {
  /** What `list_agents` gives the runtime in `delivery`. */
  delivery: { audience: string; keys: [{ kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string }] };
  /** A signature for `body`, with any claim or header field replaced. */
  sign(body: string, claims?: Partial<DeliveryClaims>, header?: Record<string, unknown>): string;
  /** The `runtime_state` row of these keys, as the runtime keeps what `list_agents` gave it. */
  keptKeys(fetchedAt?: number): { key: string; value: string };
}

export function createTestDeliverySigner(audience: string): TestDeliverySigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const kid = crypto.randomUUID();
  const delivery: TestDeliverySigner['delivery'] = { audience, keys: [{ kty: 'EC', crv: 'P-256', x: x!, y: y!, kid }] };
  return {
    delivery,
    // `AGENT_MESSAGE_KEYS` in `lib/agent-message-signature.ts`, which the e2e suites do not load.
    keptKeys: (fetchedAt = Date.now()) => ({ key: 'agentMessageKeys', value: JSON.stringify({ ...delivery, fetchedAt }) }),
    sign(body, claims = {}, header = {}) {
      const iat = Math.floor(Date.now() / 1000);
      const payload: DeliveryClaims = {
        aud: audience,
        iat,
        exp: iat + 60,
        jti: crypto.randomUUID(),
        sha256: crypto.createHash('sha256').update(body, 'utf8').digest('base64url'),
        ...claims,
      };
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signingInput = `${encode({ alg: 'ES256', kid, typ: 'agent-message+jwt', ...header })}.${encode(payload)}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${signingInput}.${signature.toString('base64url')}`;
    },
  };
}
