/**
 * Slack Channel Step Definitions
 *
 * BDD steps for testing Slack channel integration.
 * Uses the Slack Web API (via user token) to create channels, invite the bot,
 * send messages, and poll for bot responses. Channel linking is done through
 * the UI (verification code flow) for a true e2e test.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { getPrisma } from '../support/db-helper';
import {
  createSlackUserClient,
  getBotUserId,
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

  // Delete the SlackMapping if it was created
  if (slack.channelId) {
    try {
      await prisma.slackMapping.deleteMany({
        where: { slackChannelId: slack.channelId },
      });
    } catch {
      // Ignore — mapping may not exist
    }
  }

  // Leave and archive the Slack channel
  if (slack.channelId && slack.userClient) {
    try {
      await slack.userClient.conversations.leave({ channel: slack.channelId });
    } catch {
      // Ignore — may not be a member
    }
    try {
      await slack.userClient.conversations.archive({ channel: slack.channelId });
    } catch {
      // Ignore — channel may already be archived or deleted
    }
  }
});

// ============================================================================
// Given
// ============================================================================

Given('a test Slack channel exists', async () => {
  const slack = getSlackState();
  slack.channelName = `lens-agents-test-${Date.now()}`;
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

Given('I link the channel to the agent via the UI', async ({ page }) => {
  const slack = getSlackState();
  const channelsPage = new ChannelsPage(page);

  // Channel link codes live on /channels in single-agent mode (the legacy
  // agent-detail page no longer hosts this flow).
  await channelsPage.navigate();

  // Click "Get Channel Link Code" and grab the 6-char hex code
  const code = await channelsPage.getChannelLinkCode();

  // Post the verification code in the Slack channel
  await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    text: code,
  });

  // Wait for the bot to verify the code and create the mapping.
  // The UI auto-refreshes every 3s; wait for the channel to appear.
  await page.getByText(`#${slack.channelName}`).waitFor({ timeout: 30_000 });
});

// ============================================================================
// When
// ============================================================================

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
