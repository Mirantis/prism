/**
 * Voice sockets for calls and dictation. Config resolves the endpoint and credential
 * together: explicit voice settings, managed protocol discovery, or direct OpenAI. A
 * call opens a GPT-Live session and a dictation a Realtime transcription session, both
 * under the same `/v1` root. The sandbox proxy substitutes managed credential placeholders
 * on the Lens route; they must never be redirected to api.openai.com.
 * Remote sockets require WSS. Plain WS is accepted only on loopback.
 */

import { config } from '../../config';
import { logger } from '../../logger';

const REALTIME_HOST = 'wss://api.openai.com/v1/realtime';

/** The only hosts a plaintext `ws://` override may name. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The override is reported once, on the first session it opens. */
let overrideReported = false;

/**
 * The resolved voice URL, or OpenAI's own when no endpoint is configured.
 *
 * Keep the same transport constraints for managed and explicit endpoints:
 * remote credentials require TLS, while local test servers may use plaintext.
 */
function resolveRealtimeBase(): string {
  const override = config.openaiRealtimeUrl || REALTIME_HOST;

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error('Realtime endpoint is not a valid URL');
  }

  const isLoopbackPlaintext = parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'wss:' && !isLoopbackPlaintext) {
    throw new Error(
      `Realtime endpoint must be wss://, or ws:// to localhost, 127.0.0.1 or [::1] — ` +
        `${parsed.protocol}//${parsed.host} would send the API key unencrypted.`,
    );
  }

  if (!overrideReported) {
    overrideReported = true;
    // The host, never the URL: a query string an operator added is not ours to log.
    logger.info({ host: parsed.host, provider: config.realtimeProvider, source: config.realtimeSource }, '[Meeting] Realtime endpoint selected');
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
 * Where a call's voice session opens: `…/v1/live/sessions`, beside the configured
 * `…/v1/realtime` socket. The model travels in `session.start`, not in the URL.
 */
export function resolveLiveEndpoint(): RealtimeEndpoint {
  const target = new URL(resolveRealtimeBase());
  target.pathname = target.pathname.replace(/\/realtime\/?$/, '') + '/live/sessions';
  return endpointFor(target);
}

/**
 * Where a dictation opens: the Realtime socket as a transcription session, which needs
 * a transcription model and no conversation model.
 */
export function resolveTranscriptionEndpoint(): RealtimeEndpoint {
  const target = new URL(resolveRealtimeBase());
  // Appended rather than written through `searchParams`, which would rewrite the query
  // the override already carries.
  target.search = target.search ? `${target.search}&intent=transcription` : '?intent=transcription';
  return endpointFor(target);
}

/**
 * The credential and proxy for a voice socket, or a throw when no key is configured.
 *
 * Throwing rather than returning null: callers only reach this after the voice tools
 * have already gated on `isRealtimeConfigured()`, so a missing key here is a
 * programming error, not an operator misconfiguration to degrade around.
 */
function endpointFor(target: URL): RealtimeEndpoint {
  const apiKey = config.openaiRealtimeApiKey;
  if (!apiKey) {
    throw new Error(
      config.realtimeUnavailableReason || 'No Realtime credential configured — set OPENAI_REALTIME_API_KEY or enable a managed Realtime provider.',
    );
  }
  // OpenAI reads the key from `Authorization`, and an Azure resource from `api-key`: sent
  // a bearer alone, Azure redirects to a URL with the key in its query and never starts
  // the session. Each ignores the other's header, so both go.
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'api-key': apiKey };

  // Mirrors lib/proxy-dispatcher.ts: outbound calls normally traverse the
  // transparent MITM directly, and only an EXPLICIT HTTPS_PROXY needs tunnelling.
  // That module only covers `fetch`, so the WebSocket resolves its own agent.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

  return { url: target.toString(), headers, ...(proxyUrl ? { proxyUrl } : {}) };
}

/** Whether a Realtime session can be opened at all (used to gate the tools). */
export function isRealtimeConfigured(): boolean {
  return Boolean(config.openaiRealtimeApiKey);
}

/**
 * Build the `ws` client options, adding a proxy agent when HTTPS_PROXY is set.
 *
 * Returns options rather than a socket so `live-session.ts` stays testable
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
