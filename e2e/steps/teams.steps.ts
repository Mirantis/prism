/**
 * Microsoft Teams Step Definitions
 *
 * BDD steps for the @teams suite. Messages are posted as a real human via
 * a delegated Graph user token (see support/teams-helper.ts); linking is
 * done through the UI (verification-code flow) for a true e2e test.
 * Assertions land on authoritative state — TeamsMapping rows via Prisma —
 * in addition to the visible bot replies.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { getPrisma } from '../support/db-helper';
import {
  postChannelMention,
  postChatHtml,
  postChatImage,
  postChatMessage,
  postThreadReply,
  RED_SQUARE_PNG_BASE64,
  waitForBotChatReply,
  waitForBotThreadReply,
} from '../support/teams-helper';
import { TeamsChannelsPage } from '../pages/teams-channels.page';

const { Given, When, Then, Before, After } = createBdd();

// Scenario-scoped state. Safe because the suite runs with workers: 1.
const state = {
  dmLinkCode: '',
  channelLinkCode: '',
  chatMessageSentAt: '',
  threadRootId: '',
  threadReplySentAt: '',
};

// ============================================================================
// Hooks
// ============================================================================

Before({ tags: '@teams' }, async () => {
  // Skip gracefully when the Teams test tenant isn't configured.
  const requiredVars = [
    'TEAMS_E2E_USER_TOKEN',
    'TEAMS_E2E_TEAM_ID',
    'TEAMS_E2E_CHANNEL_ID',
    'TEAMS_E2E_CHAT_ID',
    'TEAMS_E2E_BOT_APP_ID',
    'TEAMS_E2E_BOT_NAME',
    'TEAMS_E2E_APP_ID',
    'TEAMS_E2E_APP_PASSWORD',
    'TEAMS_E2E_TENANT_ID',
  ];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    test.skip(true, `Teams e2e skipped — missing env vars: ${missing.join(', ')}`);
    return;
  }

  state.dmLinkCode = '';
  state.channelLinkCode = '';
  state.chatMessageSentAt = '';
  state.threadRootId = '';
  state.threadReplySentAt = '';
});

After({ tags: '@teams' }, async () => {
  // Remove whatever mappings/codes a scenario created so runs stay isolated.
  const prisma = getPrisma();
  try {
    await prisma.teamsMapping.deleteMany({});
    await prisma.teamsVerificationCode.deleteMany({});
  } catch {
    // Ignore — the tables may be empty (e.g. the suite skipped).
  }
});

// ============================================================================
// Personal chat
// ============================================================================

Given('I generate a Teams personal link code via the UI', async ({ page }) => {
  const channelsPage = new TeamsChannelsPage(page);
  await channelsPage.navigate();
  await channelsPage.waitForConfigured();
  state.dmLinkCode = await channelsPage.getDmLinkCode();
  expect(state.dmLinkCode).toMatch(/^[A-F0-9]{6}$/);
});

When('I send the link code in the Teams personal chat', async () => {
  state.chatMessageSentAt = await postChatMessage(state.dmLinkCode);
  // The adapter confirms the link as a bot chat message. "now linked" only
  // appears in the success reply — the failure replies say "already linked".
  const confirmation = await waitForBotChatReply(state.chatMessageSentAt);
  expect(confirmation).toContain('now linked');
});

When('I paste the link code as rich text in the Teams personal chat', async () => {
  // A rich-text paste: the code wrapped in formatting, which Teams delivers with
  // `text` empty and the body in a text/html attachment.
  state.chatMessageSentAt = await postChatHtml(`<p><strong>${state.dmLinkCode}</strong></p>`);
  const confirmation = await waitForBotChatReply(state.chatMessageSentAt);
  expect(confirmation).toContain('now linked');
});

Then('the Teams DM mapping exists in the database', async () => {
  const prisma = getPrisma();
  const mapping = await prisma.teamsMapping.findFirst({
    where: { teamsUserId: { not: null } },
  });
  expect(mapping).not.toBeNull();
  // The conversation id is what proactive DM sends are addressed to — the
  // link is useless without it.
  expect(mapping!.dmConversationId).toBeTruthy();
});

When('I send {string} in the Teams personal chat', async ({}, text: string) => {
  state.chatMessageSentAt = await postChatMessage(text);
});

Then('the bot should reply in the personal chat within 90 seconds', async () => {
  const reply = await waitForBotChatReply(state.chatMessageSentAt, 90_000);
  expect(reply.trim().length).toBeGreaterThan(0);
});

When(
  'I paste an image of a red square in the Teams personal chat asking {string}',
  async ({}, text: string) => {
    state.chatMessageSentAt = await postChatImage(text, RED_SQUARE_PNG_BASE64);
  }
);

Then(
  'the bot should reply in the personal chat with {string} within 90 seconds',
  async ({}, expected: string) => {
    const reply = await waitForBotChatReply(state.chatMessageSentAt, 90_000);
    expect(reply.toLowerCase()).toContain(expected.toLowerCase());
  }
);

// ============================================================================
// Channel
// ============================================================================

Given('I generate a Teams channel link code via the UI', async ({ page }) => {
  const channelsPage = new TeamsChannelsPage(page);
  await channelsPage.navigate();
  await channelsPage.waitForConfigured();
  state.channelLinkCode = await channelsPage.getChannelLinkCode();
  expect(state.channelLinkCode).toMatch(/^[A-F0-9]{6}$/);
});

When('I mention the bot in the Teams channel with the link code', async () => {
  const rootId = await postChannelMention(state.channelLinkCode);
  // "Channel linked" only appears in the success reply — the failure replies
  // say "already linked" / "Invalid code".
  const confirmation = await waitForBotThreadReply(rootId);
  expect(confirmation).toContain('Channel linked');
});

Then(
  'the Teams channel mapping exists in the database and is the main channel',
  async () => {
    const prisma = getPrisma();
    const mappings = await prisma.teamsMapping.findMany({
      where: { channelConversationId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    expect(mappings).toHaveLength(1);
    // The conversation id is stored without any ";messageid=" thread suffix.
    expect(mappings[0].channelConversationId).not.toContain(';messageid=');
    // The name comes from the team's channel list, never the raw id.
    expect(mappings[0].channelName).toBeTruthy();
    expect(mappings[0].channelName).not.toBe(mappings[0].channelConversationId);
    // First (only) linked channel is the effective main channel — flagged or
    // implicit oldest-fallback both satisfy delivery.
    const flagged = mappings.filter((m) => m.isMainChannel);
    expect(flagged.length).toBeLessThanOrEqual(1);
  }
);

When('I mention the bot in the Teams channel with {string}', async ({}, text: string) => {
  state.threadRootId = await postChannelMention(text);
});

Then('the bot should reply in that thread within 90 seconds', async () => {
  const reply = await waitForBotThreadReply(state.threadRootId, 90_000);
  expect(reply.trim().length).toBeGreaterThan(0);
});

When('I reply in that thread without a mention with {string}', async ({}, text: string) => {
  state.threadReplySentAt = await postThreadReply(state.threadRootId, text);
});

Then('the bot should answer that reply within 90 seconds', async () => {
  const reply = await waitForBotThreadReply(
    state.threadRootId,
    90_000,
    3_000,
    state.threadReplySentAt
  );
  expect(reply.trim().length).toBeGreaterThan(0);
});
