/**
 * Slack Channel Step Definitions
 *
 * BDD steps for testing Slack channel integration.
 * Uses the Slack Web API (via user token) to create channels, invite the bot,
 * send messages, and poll for bot responses. Channel linking is done through
 * the UI (verification code flow) for a true e2e test.
 */

import { randomUUID } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { getPrisma } from '../support/db-helper';
import {
  createSlackUserClient,
  getBotUserId,
  pollUntil,
  waitForBotReply,
} from '../support/slack-helper';
import { getSlackState, resetSlackState } from '../support/slack-state';
import { ChannelsPage } from '../pages/channels.page';

const { Given, When, Then, Before, After } = createBdd();

// ============================================================================
// Hooks
// ============================================================================

Before({ tags: '@slack' }, async ({ page }) => {
  // Skip gracefully if Slack credentials aren't configured
  const requiredVars = [
    'SLACK_E2E_USER_TOKEN',
    'SLACK_E2E_BOT_USER_ID',
    'SLACK_E2E_BOT_TOKEN',
    'SLACK_E2E_TEAM_ID',
    'SLACK_APP_TOKEN',
    'SLACK_E2E_EXPECTED_APP_ID',
  ];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    test.skip(true, `Slack e2e skipped — missing env vars: ${missing.join(', ')}`);
    return;
  }

  resetSlackState();
  const slack = getSlackState();
  slack.userClient = createSlackUserClient();
  slack.botUserId = getBotUserId();

  // Configure the Slack workspace via the UI
  const channelsPage = new ChannelsPage(page);
  await channelsPage.navigate();
  await channelsPage.configureSlack(process.env.SLACK_E2E_BOT_TOKEN!);

  // Wait for Socket Mode to fully establish the WebSocket connection
  await new Promise((r) => setTimeout(r, 3_000));
});

After({ tags: '@slack' }, async () => {
  const prisma = getPrisma();
  const slack = getSlackState();

  // Tear down every channel the scenario may have created (the second is only
  // set by the multi-channel scenario).
  const channelIds = [slack.channelId, slack.secondChannelId].filter(Boolean);

  for (const channelId of channelIds) {
    // Delete the SlackMapping if it was created
    try {
      await prisma.slackMapping.deleteMany({ where: { slackChannelId: channelId } });
    } catch {
      // Ignore — mapping may not exist
    }

    // Leave and archive the Slack channel
    if (slack.userClient) {
      try {
        await slack.userClient.conversations.leave({ channel: channelId });
      } catch {
        // Ignore — may not be a member
      }
      try {
        await slack.userClient.conversations.archive({ channel: channelId });
      } catch {
        // Ignore — channel may already be archived or deleted
      }
    }
  }
});

// ============================================================================
// Given
// ============================================================================

Given('a test Slack channel exists', async () => {
  const slack = getSlackState();
  // A uuid keeps the name unique in Slack, and the LLM cache treats it as an id.
  slack.channelName = `lens-agents-test-${randomUUID()}`;
  const result = await slack.userClient!.conversations.create({
    name: slack.channelName,
  });
  slack.channelId = result.channel!.id!;
});

Given('the bot is invited to the channel', async () => {
  const slack = getSlackState();
  await slack.userClient!.conversations.invite({
    channel: slack.channelId,
    users: slack.botUserId,
  });

  // After a fresh invite, Slack takes a few seconds to start routing
  // message events for this channel to the bot's Socket Mode socket.
  // Poll the channel membership until the bot appears, then add a small
  // settle window. Without this the verification-code post races ahead
  // of event-subscription propagation and the bot never sees the code.
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const info = await slack.userClient!.conversations.members({
      channel: slack.channelId,
    });
    if (info.members?.includes(slack.botUserId!)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 2_000));
});

/**
 * Post a channel link code until the channel shows up on /channels. Socket Mode
 * gives each event to one connection and never redelivers it, so a lost code
 * needs another post rather than a longer wait; a code stays valid 15 minutes.
 */
async function linkChannelByCode(
  page: Page,
  channelsPage: ChannelsPage,
  channelId: string,
  channelName: string,
): Promise<void> {
  const slack = getSlackState();
  const code = await channelsPage.getChannelLinkCode();
  const linked = page.getByText(`#${channelName}`);

  for (let attempt = 1; attempt <= 4; attempt++) {
    await slack.userClient!.chat.postMessage({ channel: channelId, text: code });
    try {
      // The UI auto-refreshes every 3s; wait for the channel to appear.
      await linked.waitFor({ timeout: 20_000 });
      return;
    } catch {
      if (attempt === 4) {
        throw new Error(`channel #${channelName} never linked after ${attempt} codes`);
      }
    }
  }
}

Given('I link the channel to the agent via the UI', async ({ page }) => {
  const slack = getSlackState();
  const channelsPage = new ChannelsPage(page);

  // Channel link codes live on /channels (the legacy agent-detail page
  // no longer hosts this flow).
  await channelsPage.navigate();
  await linkChannelByCode(page, channelsPage, slack.channelId, slack.channelName!);
});

Given('a second test Slack channel exists', async () => {
  const slack = getSlackState();
  slack.secondChannelName = `lens-agents-test2-${randomUUID()}`;
  const result = await slack.userClient!.conversations.create({
    name: slack.secondChannelName,
  });
  slack.secondChannelId = result.channel!.id!;
});

Given('the bot is invited to the second channel', async () => {
  const slack = getSlackState();
  await slack.userClient!.conversations.invite({
    channel: slack.secondChannelId,
    users: slack.botUserId,
  });

  // Same event-subscription settle as the first channel (see above).
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const info = await slack.userClient!.conversations.members({
      channel: slack.secondChannelId,
    });
    if (info.members?.includes(slack.botUserId!)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 2_000));
});

Given('I link the second channel to the agent via the UI', async ({ page }) => {
  const slack = getSlackState();
  const channelsPage = new ChannelsPage(page);
  await channelsPage.navigate();

  // "Add channel" stays available even with a channel already linked. Same
  // re-posting as the first channel, and for the same reason — this code was the
  // one-shot message that made the scenario fail whenever its event was taken.
  await linkChannelByCode(page, channelsPage, slack.secondChannelId!, slack.secondChannelName!);
});

// Regression for AGENT-74: agents migrated from the old multi-tenant world
// carry a UUID connectionId on their slack_mappings rows that no longer matches
// the env connection's teamId. Rewrite the freshly-linked mapping to such a
// legacy value to reproduce the "channel vanished from /channels" bug.
const LEGACY_CONNECTION_ID = 'c85e8ac7-2a5c-4b6c-90b7-65cb477389bd';

Given('the channel mapping has a legacy connectionId', async () => {
  const slack = getSlackState();
  const updated = await getPrisma().slackMapping.updateMany({
    where: { slackChannelId: slack.channelId },
    data: { connectionId: LEGACY_CONNECTION_ID },
  });
  expect(updated.count).toBe(1);
});

// ============================================================================
// When
// ============================================================================

When('I reload the Channels page', async ({ page }) => {
  await new ChannelsPage(page).navigate();
});

When(
  'I send a message mentioning the bot {string}',
  async ({}, message: string) => {
    const slack = getSlackState();
    const result = await slack.userClient!.chat.postMessage({
      channel: slack.channelId,
      text: `<@${slack.botUserId}> ${message}`,
    });
    slack.messageTs = result.ts!;
  },
);

// ============================================================================
// Then
// ============================================================================

let botReplyText: string | null = null;

Then(
  'the bot should reply in the thread within {int} seconds',
  async ({}, timeoutSeconds: number) => {
    const slack = getSlackState();
    botReplyText = await waitForBotReply(
      slack.userClient!,
      slack.channelId,
      slack.messageTs,
      timeoutSeconds * 1_000,
    );
    expect(botReplyText).toBeTruthy();
  },
);

Then("the bot's reply should not be empty", async () => {
  expect(botReplyText).toBeTruthy();
  expect(botReplyText!.trim().length).toBeGreaterThan(0);
});

/** A task of a `plan` block, as `conversations.replies` returns it. */
interface PlanTask {
  title?: string;
  status?: string;
  output?: unknown;
}

Then(
  "the bot's reply lists a {string} call whose output contains {string}",
  async ({}, tool: string, marker: string) => {
    const slack = getSlackState();
    const task = await pollUntil(
      async () => {
        const replies = await slack.userClient!.conversations.replies({
          channel: slack.channelId,
          ts: slack.messageTs,
          limit: 50,
        });
        return (replies.messages ?? [])
          .filter((message) => message.user === slack.botUserId)
          .flatMap((message) => (message.blocks ?? []) as Array<{ type?: string; tasks?: PlanTask[] }>)
          .filter((block) => block.type === 'plan')
          .flatMap((block) => block.tasks ?? [])
          .find((t) => t.title === tool && JSON.stringify(t.output ?? '').includes(marker));
      },
      { timeoutMs: 60_000, label: `${tool} call in the reply's plan` },
    );
    expect(task, `No ${tool} call with "${marker}" in its output arrived in the thread`).toBeTruthy();
    expect(task!.status).toBe('complete');
  },
);

Then('the linked channel is still listed', async ({ page }) => {
  const slack = getSlackState();
  await expect(page.getByText(`#${slack.channelName}`)).toBeVisible({ timeout: 15_000 });
});

Then('I can unlink the channel from the UI', async ({ page }) => {
  const slack = getSlackState();
  await new ChannelsPage(page).unlinkChannel();
  // Authoritative: the mapping row is gone from the runtime DB.
  const remaining = await getPrisma().slackMapping.count({
    where: { slackChannelId: slack.channelId },
  });
  expect(remaining).toBe(0);
});

// ============================================================================
// Multiple channels + main channel
// ============================================================================

Then('both channels are listed on the Channels page', async ({ page }) => {
  const slack = getSlackState();
  await expect(page.getByText(`#${slack.channelName}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`#${slack.secondChannelName}`)).toBeVisible({ timeout: 15_000 });
});

Then('the first channel is the main channel', async ({ page }) => {
  const slack = getSlackState();
  // The first-linked channel is main by default.
  expect(await new ChannelsPage(page).isChannelMain(slack.channelName)).toBe(true);
});

When('I set the second channel as the main channel', async ({ page }) => {
  const slack = getSlackState();
  await new ChannelsPage(page).setChannelAsMain(slack.secondChannelName);
});

Then('the second channel is the main channel', async ({ page }) => {
  const slack = getSlackState();
  expect(await new ChannelsPage(page).isChannelMain(slack.secondChannelName)).toBe(true);
});

Then('only the second channel is flagged main in the database', async () => {
  const slack = getSlackState();
  const prisma = getPrisma();
  // Authoritative: exactly one row flagged, and it's the second channel.
  const flagged = await prisma.slackMapping.findMany({
    where: { isMainChannel: true, slackChannelId: { not: null } },
    select: { slackChannelId: true },
  });
  expect(flagged.map((m) => m.slackChannelId)).toEqual([slack.secondChannelId]);
});
