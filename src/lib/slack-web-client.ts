/**
 * `WebClient` subclass that strips the `token` field from every outbound
 * request body, so bot-token auth flows **only** via the `Authorization`
 * header. This lets the Mirantis Agent Platform sandbox MITM proxy inject the real token
 * via its header-rewriting credential injection (`__nexus_cred:<uuid>__`
 * sentinel in env → real `xoxb-…` at the proxy); the body no longer
 * carries the sentinel, so Slack never sees the placeholder.
 *
 * Why this works:
 *   - Slack's API accepts Bearer auth via `Authorization` alone.
 *     (slackapi/node-slack-sdk#1132: "POST body params" still supported
 *     but optional — header is preferred.)
 *   - `@slack/web-api` sets `headers.Authorization = Bearer <token>` from
 *     the constructor token and from a call's own `token` option,
 *     independent of the body.
 *
 * Mechanism: the SDK sends every request through the `fetch` option on the
 * `WebClient` constructor, after it has serialized the body into a
 * form-urlencoded string, or a `FormData` for a file upload. We drop `token`
 * from either. Bolt's `respond()` sends a JSON body through the same `fetch`,
 * and that passes unchanged.
 */
import { type FetchFunction, WebClient, WebClientOptions } from '@slack/web-api';
import { config } from '../config';

function isFormEncoded(headers: Record<string, string> | undefined): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === 'content-type' && value.startsWith('application/x-www-form-urlencoded'),
  );
}

export const stripBodyToken: FetchFunction = (url, init) => {
  const body = init?.body;
  if (typeof body === 'string' && isFormEncoded(init?.headers)) {
    const params = new URLSearchParams(body);
    if (params.has('token')) {
      params.delete('token');
      return fetch(url, { ...init, body: params.toString() });
    }
  } else if (body instanceof FormData) {
    body.delete('token');
  }
  return fetch(url, init);
};

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
 * smallest: `files.uploadV2` POSTs the file bytes through this same client,
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

/**
 * The options of every Slack Web API client this runtime builds: the bounded
 * policy above, the body-token strip, and `SLACK_API_URL` when it is set.
 */
export function slackClientOptions(): WebClientOptions {
  return {
    ...BOUNDED_SLACK_CLIENT_OPTIONS,
    fetch: stripBodyToken,
    ...(config.slackApiUrl ? { slackApiUrl: config.slackApiUrl } : {}),
  };
}

/**
 * Whether a request to `url` may carry the bot token: Slack's own hosts over
 * HTTPS, and the `SLACK_API_URL` origin.
 */
export function mayReceiveSlackToken(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  if (config.slackApiUrl && target.origin === new URL(config.slackApiUrl).origin) return true;
  return (
    target.protocol === 'https:' &&
    (target.hostname === 'slack.com' || target.hostname.endsWith('.slack.com'))
  );
}

export class SlackWebClient extends WebClient {
  constructor(token?: string, opts?: WebClientOptions) {
    super(token, { ...slackClientOptions(), ...opts, fetch: stripBodyToken });
  }
}
