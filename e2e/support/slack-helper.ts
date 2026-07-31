/**
 * Slack E2E Helper — WebClient wrapper and polling utilities for Slack e2e tests.
 */

import { WebClient } from '@slack/web-api';

export function createSlackUserClient(): WebClient {
  const token = process.env.SLACK_E2E_USER_TOKEN;
  if (!token) {
    throw new Error('SLACK_E2E_USER_TOKEN env var is required for Slack e2e tests');
  }
  return new WebClient(token);
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
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    // Look for a reply from a bot (has bot_id) that isn't the parent message
    const botReply = result.messages?.find(
      (m) => m.bot_id && m.ts !== threadTs,
    );
    if (botReply?.text) {
      return botReply.text;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}

/**
 * Poll a message's reactions until the given emoji is present (or absent).
 * Reads via conversations.replies — the same scope waitForBotReply already
 * uses; reactions come inline on the parent message, so no extra user scope
 * is needed. Returns true when the desired state was observed, false on
 * timeout.
 */
export async function waitForReactionState(
  client: WebClient,
  channel: string,
  messageTs: string,
  emoji: string,
  present: boolean,
  timeoutMs = 20_000,
  intervalMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await client.conversations.replies({
      channel,
      ts: messageTs,
      limit: 1,
    });
    const reactions = result.messages?.[0]?.reactions ?? [];
    const hasEmoji = reactions.some((r) => r.name === emoji);
    if (hasEmoji === present) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return false;
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hist = await client.conversations.history({ channel, oldest, limit: 20 });
    const msg = hist.messages?.find(
      (m) =>
        Array.isArray(m.files) &&
        (m.files as SlackSharedFile[]).some(
          (f) => f.name === opts.filename || f.title === opts.filename,
        ),
    );
    if (msg?.ts) return msg.ts;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`file_share message for ${opts.filename} not found in channel ${channel}`);
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    for (const m of result.messages ?? []) {
      const file = (m.files as SlackSharedFile[] | undefined)?.find(
        (f) => (f.name === filename || f.title === filename) && (!f.user || f.user === botUserId),
      );
      if (file) return file;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
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
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await client.conversations.history({
      channel,
      oldest: sinceTs,
      inclusive: false,
      limit: 20,
    });

    const botMessage = result.messages?.find((m) => m.bot_id && m.text);
    if (botMessage?.text) {
      return botMessage.text;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}
