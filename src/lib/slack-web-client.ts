/**
 * `WebClient` subclass that strips the `token` field from every outbound
 * request body, so bot-token auth flows **only** via the `Authorization`
 * header. This lets the Nexus sandbox MITM proxy inject the real token
 * via its header-rewriting credential injection (`__nexus_cred:<uuid>__`
 * sentinel in env → real `xoxb-…` at the proxy); the body no longer
 * carries the sentinel, so Slack never sees the placeholder.
 *
 * Why this works:
 *   - Slack's API accepts Bearer auth via `Authorization` alone.
 *     (slackapi/node-slack-sdk#1132: "POST body params" still supported
 *     but optional — header is preferred.)
 *   - `@slack/web-api` sets `headers.Authorization = Bearer <token>` from
 *     the constructor token (WebClient.js:153-154), independent of the
 *     body.
 *
 * Mechanism: the SDK exposes a `requestInterceptor` option on the
 * `WebClient` constructor. Axios interceptors execute in reverse
 * registration order, so by the time our interceptor fires, the SDK's
 * own `serializeApiCallData` has already run and `config.data` is the
 * serialized form-urlencoded string. We drop `token` from it.
 *
 * Known gap: multipart/form-data requests (file uploads) keep the token
 * in a binary FormData body. Not exercised by the agent today; fix when
 * we add Slack file uploads.
 */
import { WebClient, WebClientOptions } from '@slack/web-api';
import type { InternalAxiosRequestConfig } from 'axios';
import { logger } from '../logger';

export function stripBodyToken(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const data = config.data;
  if (typeof data === 'string') {
    const params = new URLSearchParams(data);
    if (params.has('token')) {
      params.delete('token');
      config.data = params.toString();
    }
    return config;
  }
  // FormData path (file uploads) — token lives inside the multipart body
  // as an appended field. The `form-data` package has no delete(), and
  // no agent flow currently uploads files, so log once and move on.
  if (data && typeof data === 'object' && typeof (data as { getBoundary?: unknown }).getBoundary === 'function') {
    logger.warn('[SlackWebClient] multipart body seen; token may leak in body. File-upload path not supported by body-token stripper.');
  }
  return config;
}

/**
 * Bounded request policy for every Slack call this runtime makes.
 *
 * `@slack/web-api`'s defaults are `timeout: 0` (no per-request deadline) and
 * `tenRetriesInAboutThirtyMinutes`. Combined, one unreachable or hanging Slack
 * endpoint can keep a single `auth.test` outstanding for the better part of half
 * an hour — and boot awaits that call, so the whole runtime (HTTP server
 * included) never starts. Any caller waiting on the port then fails with a
 * timeout that points at the port, not at Slack.
 *
 * So: a request deadline, and a handful of retries measured in seconds — a
 * couple of minutes at the absolute worst instead of thirty, and it still rides
 * out the transient 5xx/network blips retries exist for. (A 429 can still push
 * past that: `retry-after` is slept *inside* the retried attempt, by design —
 * ignoring Slack's own backoff would be worse than waiting it out.)
 *
 * The deadline is sized for the largest thing this client sends, not the
 * smallest: `files.uploadV2` POSTs the file bytes on this same axios instance,
 * so `timeout` has to cover a multi-MB upload. Callers that only ever exchange
 * JSON — the boot `auth.test`, which the port waits behind — pass a tighter one.
 *
 * Applied to the steady-state client too (it is the same client): a real outage
 * should surface as a failed post the caller can see and log, not as an
 * invisible 30-minute stall.
 *
 * **Do not hand these options to a Socket Mode client.** `SocketModeClient`
 * installs its own `{ retries: 100, factor: 1.3 }` for `apps.connections.open`
 * *only* when `retryConfig` is undefined, and it classifies a request timeout as
 * unrecoverable — so a client bounded like this would stop reconnecting after a
 * blip instead of retrying for hours (see `slack-adapter.service.ts`).
 */
export const BOUNDED_SLACK_CLIENT_OPTIONS: WebClientOptions = {
  timeout: 30_000,
  retryConfig: {
    retries: 3,
    factor: 2,
    minTimeout: 1_000,
    maxTimeout: 8_000,
    randomize: true,
  },
};

export class SlackWebClient extends WebClient {
  constructor(token?: string, opts?: WebClientOptions) {
    super(token, { ...BOUNDED_SLACK_CLIENT_OPTIONS, ...opts, requestInterceptor: stripBodyToken });
  }
}
