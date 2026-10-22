/**
 * Agent Message Signature
 *
 * Single owner of "did the delivery service send this agent message?".
 *
 * The Lens Agents private ingress admits every member of the project to
 * `POST /agents/agent-messages`: a person, a person's API token, another
 * agent's own token, and the delivery service's session. It names none of
 * them but a person. So the service signs each delivery, and the runtime takes
 * none without that signature:
 *
 *   `x-agent-message-signature` holds an ES256 compact JWT, `typ`
 *   `agent-message+jwt`, for this agent (`aud`) and the SHA-256 of the exact
 *   body (`sha256`, base64url), good for a minute.
 *
 * The keys and the audience come from the `delivery` field of the
 * `list_agents` answer, which the runtime asks for itself through the Lens
 * Agents MCP. They are kept in `runtime_state`, so a restart costs no call, and
 * trusted for an hour, so a key the service dropped is soon no longer trusted.
 * A signature that names a key the runtime does not hold asks again, at most
 * every 30 seconds, which is how a new key reaches the runtime.
 */

import crypto from 'crypto';
import { z } from 'zod';
import { logger } from '../logger';
import { runtimeStateService } from '../services/runtime-state.service';
import { callListAgents } from './mcp-client';

export const AGENT_MESSAGE_SIGNATURE_HEADER = 'x-agent-message-signature';

/** The `runtime_state` key of the keys a delivery is checked with. */
export const AGENT_MESSAGE_KEYS = 'agentMessageKeys';

const TOKEN_TYPE = 'agent-message+jwt';
/** Keys read longer ago than this are read again before they are trusted. */
const KEYS_MAX_AGE_MS = 60 * 60_000;
/** A signature with an unknown key asks for the keys at most this often. */
const REFRESH_INTERVAL_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;
/** How far the service's clock may be from this one. */
const CLOCK_SKEW_SECONDS = 30;

const publicKey = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1),
});
const deliveryCheck = z.object({ audience: z.string().min(1), keys: z.array(publicKey).min(1).max(10) });
/** The first line of the `list_agents` answer, of which only `delivery` is read here. */
const listAgentsDelivery = z.object({ delivery: deliveryCheck });
const storedKeys = deliveryCheck.extend({ fetchedAt: z.number() });

export type AgentMessageKeys = z.infer<typeof storedKeys>;

/** Why a delivery was refused: 401 for a signature that is missing or wrong, 503 when the keys cannot be read now. */
export type SignatureOutcome = { ok: true } | { ok: false; status: 401 | 503; reason: string };

let lastRefreshAt = Number.NEGATIVE_INFINITY;
let refreshing: Promise<AgentMessageKeys | null> | null = null;

const refuse = (status: 401 | 503, reason: string): SignatureOutcome => ({ ok: false, status, reason });

/**
 * Check a delivery's signature against the exact bytes it carried. Never
 * throws: an unexpected shape is a refusal.
 */
export async function verifyAgentMessageSignature(
  token: string | undefined,
  rawBody: Buffer | undefined,
  now: number = Date.now(),
): Promise<SignatureOutcome> {
  if (!token) return refuse(401, 'no signature');
  if (!rawBody) return refuse(401, 'no body to check');
  const parts = token.split('.');
  if (parts.length !== 3) return refuse(401, 'not a compact JWT');
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  const kid = header?.kid;
  if (header?.alg !== 'ES256' || header.typ !== TOKEN_TYPE || typeof kid !== 'string') {
    return refuse(401, 'not an agent message token');
  }

  let keys = await readKeys();
  if (!holds(keys, kid, now)) keys = (await refreshKeys(now)) ?? keys;
  // Old keys are not trusted in place of keys that cannot be read: the service tries again later.
  if (!keys || now - keys.fetchedAt >= KEYS_MAX_AGE_MS) return refuse(503, 'the delivery keys cannot be read now');
  const jwk = keys.keys.find((key) => key.kid === kid);
  if (!jwk) return refuse(401, 'signed with a key the delivery service does not list');

  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    const signature = Buffer.from(encodedSignature, 'base64url');
    valid =
      signature.length === 64 &&
      crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return refuse(401, 'bad signature');

  const claims = decodeJson(encodedClaims) ?? {};
  const { aud, exp, iat, sha256 } = claims;
  const seconds = now / 1000;
  if (aud !== keys.audience) return refuse(401, 'signed for another agent');
  if (typeof exp !== 'number' || exp <= seconds - CLOCK_SKEW_SECONDS) return refuse(401, 'expired');
  if (typeof iat !== 'number' || iat > seconds + CLOCK_SKEW_SECONDS) return refuse(401, 'issued in the future');
  const digest = crypto.createHash('sha256').update(rawBody).digest('base64url');
  if (typeof sha256 !== 'string' || !sameText(sha256, digest)) return refuse(401, 'signed for another body');
  return { ok: true };
}

/** Whether the kept keys are recent enough and hold `kid`. */
function holds(keys: AgentMessageKeys | null, kid: string, now: number): boolean {
  return keys !== null && now - keys.fetchedAt < KEYS_MAX_AGE_MS && keys.keys.some((key) => key.kid === kid);
}

async function readKeys(): Promise<AgentMessageKeys | null> {
  const stored = await runtimeStateService.get(AGENT_MESSAGE_KEYS).catch(() => null);
  if (!stored) return null;
  try {
    const parsed = storedKeys.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The keys as `list_agents` gives them now, or null when they cannot be read, or were read too recently to ask again. */
async function refreshKeys(now: number): Promise<AgentMessageKeys | null> {
  if (refreshing) return refreshing;
  if (now - lastRefreshAt < REFRESH_INTERVAL_MS) return null;
  lastRefreshAt = now;
  refreshing = fetchKeys(now).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function fetchKeys(now: number): Promise<AgentMessageKeys | null> {
  try {
    // An empty version matches none, and an answer to a version has no
    // states, so the service asks no other runtime for this call.
    const text = await callListAgents({ knownVersion: '' }, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    if (text === null) return null;
    const answer = listAgentsDelivery.safeParse(JSON.parse(text.split('\n', 1)[0]!));
    if (!answer.success) {
      logger.warn('[AgentMessages] list_agents gave no delivery keys');
      return null;
    }
    const keys: AgentMessageKeys = { ...answer.data.delivery, fetchedAt: now };
    await runtimeStateService.set(AGENT_MESSAGE_KEYS, JSON.stringify(keys));
    return keys;
  } catch (err) {
    logger.warn({ err }, '[AgentMessages] Could not read the delivery keys');
    return null;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sameText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Forget when the keys were last asked for, as a restart would. For tests. */
export function resetAgentMessageKeysForTests(): void {
  lastRefreshAt = Number.NEGATIVE_INFINITY;
  refreshing = null;
}
