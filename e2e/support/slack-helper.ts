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
