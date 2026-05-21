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

export class SlackWebClient extends WebClient {
  constructor(token?: string, opts?: WebClientOptions) {
    super(token, { ...opts, requestInterceptor: stripBodyToken });
  }
}
