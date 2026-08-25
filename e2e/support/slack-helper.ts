/**
 * Slack E2E Helper — WebClient wrapper and polling utilities for Slack e2e tests.
 */

import { ErrorCode, WebClient, type WebClientOptions } from '@slack/web-api';

/**
 * `WebClient` defaults to `timeout: 0` and `tenRetriesInAboutThirtyMinutes`, and
 * sleeps out a 429 inside the request. These bound the per-request timeout and
 * the backoff between attempts; a 429 is bounded by `pollUntil` instead.
 */
export const SLACK_CLIENT_OPTIONS: WebClientOptions = {
  timeout: 8_000,
  retryConfig: { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 2_000, randomize: true },
};

export function createSlackUserClient(): WebClient {
  const token = process.env.SLACK_E2E_USER_TOKEN;
  if (!token) {
    throw new Error('SLACK_E2E_USER_TOKEN env var is required for Slack e2e tests');
  }
  return new WebClient(token, SLACK_CLIENT_OPTIONS);
}

/** Refusals another identical attempt could get past. */
const RETRYABLE_SLACK_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
]);

/**
 * Whether an error means "stop" rather than "not yet". Only a platform error
 * carries Slack's verdict on the request itself (`invalid_auth`,
 * `channel_not_found`); transport failures say nothing about its merits.
 */
function isFatalSlackError(err: unknown): boolean {
  const coded = err as { code?: string; data?: { error?: string } } | null;
  if (coded?.code !== ErrorCode.PlatformError) return false;
  const reason = coded.data?.error;
  return reason !== undefined && !RETRYABLE_SLACK_ERRORS.has(reason);
}

/**
 * Poll `attempt` until it reports a result; give up at the deadline and return
 * null. Each attempt races the time still left, so the deadline is the only
 * budget. A throwing attempt is a retry, except an error Slack itself named.
 */
export async function pollUntil<T>(
  attempt: () => Promise<T | null | undefined>,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T | null> {
  const { timeoutMs, intervalMs = 2_000, label } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await raceDeadline(attempt(), deadline - Date.now(), label);
      if (result !== null && result !== undefined) return result;
    } catch (err) {
      if (isFatalSlackError(err)) throw err;
      lastError = err;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }

  if (lastError) {
    console.warn(
      `[slack-e2e] ${label}: gave up after ${timeoutMs}ms; last error: ${String(lastError)}`,
    );
  }
  return null;
}

/**
 * Settle `p` or reject when `ms` runs out. Nothing can cancel an in-flight
 * `WebClient` request, so the abandoned call's rejection is swallowed.
 */
function raceDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  // Before any early return: `attempt()` has already been called, and vitest
  // fails a run on an unhandled rejection.
  p.catch(() => undefined);
  if (ms <= 0) return Promise.reject(new Error(`${what}: no time left`));
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded the remaining ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getBotUserId(): string {
  const id = process.env.SLACK_E2E_BOT_USER_ID;
  if (!id) {
    throw new Error('SLACK_E2E_BOT_USER_ID env var is required for Slack e2e tests');
  }
  return id;
}

/**
 * Poll for a bot reply in a Slack thread.
 * Returns the reply text, or null if no reply arrives before timeout.
 */
export async function waitForBotReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  timeoutMs = 60_000,
  intervalMs = 2_000,
): Promise<string | null> {
  return pollUntil(
    async () => {
      const result = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
      // A reply from a bot (has bot_id) that isn't the parent message. `m.text`
      // is part of the predicate, not an afterthought: a file-share reply can
      // carry none, and returning '' would end the wait on a message that says
      // nothing.
      return result.messages?.find((m) => m.bot_id && m.ts !== threadTs && m.text)?.text ?? null;
    },
    { timeoutMs, intervalMs, label: `bot reply in ${channel}/${threadTs}` },
  );
}

/** A file as it appears on a Slack message (subset we assert against). */
export interface SlackSharedFile {
  id?: string;
  name?: string;
  title?: string;
  user?: string;
  url_private?: string;
  url_private_download?: string;
}

/**
 * Upload a file to a channel as a user (simulates a human sharing an
 * attachment). `initialComment` becomes the file-share message text — include
 * a `<@bot>` mention there to make the bot process it. Returns the ts of the
 * resulting file-share message so callers can poll its thread for the reply.
 */
export async function uploadFileToChannel(
  client: WebClient,
  channel: string,
  opts: { filename: string; content: string; initialComment?: string },
  timeoutMs = 30_000,
): Promise<string> {
  // Slack ts are unix-seconds with microseconds; use a `oldest` floor so the
  // history scan only sees messages from this upload onward.
  const oldest = (Date.now() / 1000 - 5).toFixed(6);
  await client.files.uploadV2({
    channel_id: channel,
    filename: opts.filename,
    file: Buffer.from(opts.content),
    ...(opts.initialComment ? { initial_comment: opts.initialComment } : {}),
  });

  // The upload posts a file_share message; find its ts (uploadV2's response
  // doesn't reliably carry the share ts, so poll channel history).
  const ts = await pollUntil(
    async () => {
      const hist = await client.conversations.history({ channel, oldest, limit: 20 });
      return (
        hist.messages?.find(
          (m) =>
            Array.isArray(m.files) &&
            (m.files as SlackSharedFile[]).some(
              (f) => f.name === opts.filename || f.title === opts.filename,
            ),
        )?.ts ?? null
      );
    },
    { timeoutMs, intervalMs: 1_000, label: `file_share ts for ${opts.filename}` },
  );
  if (!ts) {
    throw new Error(`file_share message for ${opts.filename} not found in channel ${channel}`);
  }
  return ts;
}

/**
 * Poll a thread for a file the BOT shared (uploader === botUserId) whose name
 * or title matches `filename`. Returns the file object (for download) or null.
 */
export async function waitForBotFileInThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  filename: string,
  botUserId: string,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<SlackSharedFile | null> {
  return pollUntil<SlackSharedFile>(
    async () => {
      const result = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
      for (const m of result.messages ?? []) {
        const file = (m.files as SlackSharedFile[] | undefined)?.find(
          (f) => (f.name === filename || f.title === filename) && (!f.user || f.user === botUserId),
        );
        if (file) return file;
      }
      return null;
    },
    { timeoutMs, intervalMs, label: `bot file ${filename} in ${channel}/${threadTs}` },
  );
}

/** Download a Slack file's bytes as text using a token authorized to see it. */
export async function downloadSlackFileText(file: SlackSharedFile, token: string): Promise<string> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error('shared file has no download URL');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Poll for a bot message posted to a channel after a given timestamp.
 * Used for heartbeat-triggered replies, which post to the channel rather
 * than threading off the original message.
 */
export async function waitForBotMessageInChannel(
  client: WebClient,
  channel: string,
  sinceTs: string,
  timeoutMs = 90_000,
  intervalMs = 2_000,
): Promise<string | null> {
  return pollUntil(
    async () => {
      const result = await client.conversations.history({
        channel,
        oldest: sinceTs,
        inclusive: false,
        limit: 20,
      });
      return result.messages?.find((m) => m.bot_id && m.text)?.text ?? null;
    },
    { timeoutMs, intervalMs, label: `bot message in ${channel} after ${sinceTs}` },
  );
}
