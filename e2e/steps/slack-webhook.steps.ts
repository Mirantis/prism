/**
 * Slack Webhook Step Definitions
 *
 * A Slack webhook with a chosen channel: the subscription is created through
 * the management API, the event is POSTed by the shared webhook steps, and the
 * result is read back from Slack's channel history.
 *
 * Reuses the @slack Before/After hook and the channel-setup Givens from
 * slack-channel.steps.ts via the shared slack-state module.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { getSlackState } from '../support/slack-state';
import { pollUntil } from '../support/slack-helper';

const { Given, Then } = createBdd();

/**
 * Per channel, the ts of its newest message when the webhook was set up; later
 * bot posts are the webhook's. The floor is a Slack ts, so the runner's clock
 * cannot move it past the post.
 */
const floors = new Map<string, string>();

async function newestTs(channel: string): Promise<string> {
  const slack = getSlackState();
  const history = await slack.userClient!.conversations.history({ channel, limit: 1 });
  return history.messages?.[0]?.ts ?? '0';
}

/** Bot posts in `channel` above its floor. Authored by the bot user, not by its bot_id. */
async function botPostsSince(channel: string): Promise<string[]> {
  const slack = getSlackState();
  const history = await slack.userClient!.conversations.history({
    channel,
    oldest: floors.get(channel),
    inclusive: false,
    limit: 50,
  });
  return (history.messages ?? []).filter((m) => m.user === slack.botUserId).map((m) => m.text ?? '');
}

Given(
  'a deliver-only Slack webhook {string} with template {string} posts to the second channel',
  async ({ page }, name: string, template: string) => {
    const slack = getSlackState();
    const receiver = await page.request.patch('/agents/webhooks/receiver', { data: { enabled: true } });
    expect(receiver.ok()).toBe(true);
    const created = await page.request.post('/agents/webhook-subscriptions', {
      data: {
        name,
        prompt: template,
        deliverOnly: true,
        deliverTo: 'slack',
        slackChannelIds: [slack.secondChannelId],
        authType: 'none',
      },
    });
    expect(created.status()).toBe(201);
    for (const channel of [slack.channelId, slack.secondChannelId]) {
      floors.set(channel, await newestTs(channel));
    }
  },
);

Then('the bot posts {string} in the second channel', async ({}, text: string) => {
  const slack = getSlackState();
  const posted = await pollUntil(
    async () => (await botPostsSince(slack.secondChannelId)).find((t) => t.includes(text)),
    { timeoutMs: 30_000, label: `bot post "${text}" in the second channel` },
  );
  expect(posted).toBeTruthy();
});

// A deliver-only event is published before the webhook answers 200, so every
// post it makes exists by the time the second channel shows one.
Then('the bot posts nothing in the first channel', async () => {
  const slack = getSlackState();
  expect(await botPostsSince(slack.channelId)).toEqual([]);
});
