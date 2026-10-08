/**
 * Lazily-built proxy dispatcher for the runtime's plain-`fetch` calls.
 *
 * Outbound calls normally traverse the sandbox network directly (a transparent
 * MITM that rewrites `__nexus_cred:…__` credential sentinels on the wire), so a
 * plain `fetch` matches that path with no extra work. When an EXPLICIT
 * `HTTPS_PROXY` is configured we route through it via undici's ProxyAgent so any
 * header rewriting still applies.
 *
 * Memoized process-wide: one ProxyAgent shared by every caller, built on first
 * use. Returns `null` — never throws — when no proxy is configured or when
 * undici can't be loaded, so callers degrade to a direct `fetch`.
 *
 * `HTTP_PROXY` and `NO_PROXY` are deliberately not read. That's a pre-existing
 * gap; honouring them would change the behaviour of every channel's file
 * download.
 */
import { logger } from '../logger';

let proxyDispatcherPromise: Promise<unknown> | undefined;

/**
 * The shared proxy dispatcher, or `null` to fetch directly.
 *
 * Returns `unknown` on purpose: `dispatcher` is an undici extension to fetch's
 * init that the two bundled Dispatcher type copies (undici vs undici-types)
 * disagree on, so call sites pass it through a loosely-typed init object.
 */
export async function getProxyDispatcher(): Promise<unknown> {
  if (!proxyDispatcherPromise) {
    proxyDispatcherPromise = (async () => {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      if (!proxy) return null;
      try {
        const { ProxyAgent } = await import('undici');
        return new ProxyAgent(proxy);
      } catch (err) {
        logger.warn(
          '[Proxy] HTTPS_PROXY set but undici ProxyAgent unavailable: %s',
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    })();
  }
  return proxyDispatcherPromise;
}
