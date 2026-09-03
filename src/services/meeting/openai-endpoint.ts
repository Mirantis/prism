/**
 * Where the meeting bot's Realtime WebSocket goes, and how it authenticates.
 *
 * Unlike every other model call in the runtime, this one never rides the Lens
 * Agents LLM gateway. Every vendor that gateway fronts — Bedrock, Azure (Claude
 * on Microsoft Foundry), Bedrock Mantle and OpenAI — is reached over a
 * request/response HTTP mount, and none of those carries a realtime voice
 * surface: the `…/llm/openai` mount routes POST only. So there is no
 * `/llm/{vendor}` route to go through and the connection goes to
 * `api.openai.com`, unless `OPENAI_REALTIME_URL` names another host.
 *
 * That override carries the same `Authorization` header, so the scheme is checked
 * rather than trusted: `wss://` to any host, and plaintext `ws://` only to a
 * loopback host, which is a local voice model on the same machine. Anything else
 * would put the key on the wire in the clear.
 *
 * That is still credential-safe in a sandbox: `OPENAI_API_KEY` may be a
 * `__nexus_cred:<uuid>__` sentinel, and the sandbox's egress MITM swaps it for the
 * real key on the wire — the same mechanism the Slack and Bedrock paths rely on.
 * The key is only ever sent as a header, never in a URL or a message body, so the
 * sentinel is always in a place the proxy can rewrite. Deployments with egress
 * filtering must allow-list `api.openai.com`.
 */

import { config } from '../../config';
import { logger } from '../../logger';

const REALTIME_HOST = 'wss://api.openai.com/v1/realtime';

/** The only hosts a plaintext `ws://` override may name. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The override is reported once, on the first session it opens. */
let overrideReported = false;

/**
 * The base URL the socket connects to, from `OPENAI_REALTIME_URL` or OpenAI's own.
 *
 * Throws on an override the key must not be sent to. The value is the operator's, so
 * this is not an injection boundary; it is documented as a test knob while it can
 * redirect production voice traffic, so a plaintext host is refused in words rather
 * than being connected to quietly.
 */
function resolveRealtimeBase(): string {
  const override = config.openaiRealtimeUrl;
  if (!override) return REALTIME_HOST;

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(`OPENAI_REALTIME_URL is not a URL: ${override}`);
  }

  const isLoopbackPlaintext = parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'wss:' && !isLoopbackPlaintext) {
    throw new Error(
      `OPENAI_REALTIME_URL must be wss://, or ws:// to localhost, 127.0.0.1 or [::1] — ` +
        `${parsed.protocol}//${parsed.host} would send the API key unencrypted.`,
    );
  }

  if (!overrideReported) {
    overrideReported = true;
    // The host, never the URL: a query string an operator added is not ours to log.
    logger.info(`[Meeting] Realtime socket pointed at ${parsed.host} by OPENAI_REALTIME_URL`);
  }
  return override;
}

export interface RealtimeEndpoint {
  url: string;
  headers: Record<string, string>;
  /** Set when an explicit HTTPS_PROXY must be tunnelled through. */
  proxyUrl?: string;
}

/**
 * Resolve the Realtime endpoint, or throw when no key is configured.
 *
 * Throwing rather than returning null: callers only reach this after the meeting
 * tools have already gated on `isRealtimeConfigured()`, so a missing key here is
 * a programming error, not an operator misconfiguration to degrade around.
 */
export function resolveRealtimeEndpoint(model?: string): RealtimeEndpoint {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set — the Realtime API is required for voice meetings.',
    );
  }

  const modelId = model || config.openaiRealtimeModel;
  // `OPENAI_REALTIME_URL` points the socket at a local voice model. The key is
  // still required, so the only thing that changes is the host.
  const target = new URL(resolveRealtimeBase());
  // Appended rather than written through `searchParams`, which would keep the model
  // name but rewrite a space as `+`, and it holds a query the override already carries.
  target.search = target.search
    ? `${target.search}&model=${encodeURIComponent(modelId)}`
    : `?model=${encodeURIComponent(modelId)}`;
  const url = target.toString();

  // Realtime went GA in August 2025; the `OpenAI-Beta: realtime=v1` header the
  // preview models required is no longer sent.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };

  // Mirrors lib/proxy-dispatcher.ts: outbound calls normally traverse the
  // transparent MITM directly, and only an EXPLICIT HTTPS_PROXY needs tunnelling.
  // That module only covers `fetch`, so the WebSocket resolves its own agent.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

  return { url, headers, ...(proxyUrl ? { proxyUrl } : {}) };
}

/** Whether a Realtime session can be opened at all (used to gate the tools). */
export function isRealtimeConfigured(): boolean {
  return Boolean(config.openaiApiKey);
}

/**
 * Build the `ws` client options, adding a proxy agent when HTTPS_PROXY is set.
 *
 * Returns options rather than a socket so `realtime-session.ts` stays testable
 * against a local mock server. Degrades to a direct connection — never throws —
 * when the proxy agent can't be loaded, matching `getProxyDispatcher()`.
 */
export async function buildRealtimeSocketOptions(
  endpoint: RealtimeEndpoint,
): Promise<{ headers: Record<string, string>; agent?: unknown }> {
  if (!endpoint.proxyUrl) return { headers: endpoint.headers };

  try {
    // Loaded dynamically and accepted in either export shape: the package is
    // only present transitively, and v5 exports the constructor as the module
    // itself while v6+ exports it as a named property.
    const mod: unknown = await import('https-proxy-agent');
    const candidate =
      (mod as { HttpsProxyAgent?: unknown }).HttpsProxyAgent ??
      (mod as { default?: unknown }).default ??
      mod;
    if (typeof candidate !== 'function') throw new Error('no HttpsProxyAgent constructor');
    const Agent = candidate as new (proxy: string) => unknown;
    return { headers: endpoint.headers, agent: new Agent(endpoint.proxyUrl) };
  } catch (err) {
    logger.warn(
      '[Meeting] HTTPS_PROXY set but https-proxy-agent unavailable, connecting directly: %s',
      err instanceof Error ? err.message : String(err),
    );
    return { headers: endpoint.headers };
  }
}
