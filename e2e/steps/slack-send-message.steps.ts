/**
 * send_message step definitions (@slack).
 *
 * The channel Givens, the hooks and the thread-reply step live in
 * slack-channel.steps.ts; these steps share their state through slack-state.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { getPrisma } from '../support/db-helper';
import { pollUntil } from '../support/slack-helper';
import { getSlackState } from '../support/slack-state';

const { When, Then } = createBdd();

// Scenario-scoped. Safe because the suite runs with workers: 1.
const sent = { marker: '', humanUserId: '' };

When('I ask the bot to post a message that mentions me in the second channel', async () => {
  const slack = getSlackState();
  const auth = await slack.userClient!.auth.test();
  sent.humanUserId = auth.user_id!;
  sent.marker = `E2E-SEND-${Date.now()}`;

  const result = await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    text:
      `<@${slack.botUserId}> Use send_message to post a new message in #${slack.secondChannelName}. ` +
      `It must contain the exact text ${sent.marker} and mention me. Then reply here with the word done.`,
  });
  slack.messageTs = result.ts!;
});

Then("the second channel has the bot's message mentioning me within {int} seconds", async ({}, timeoutSeconds: number) => {
  const slack = getSlackState();
  const message = await pollUntil(
    async () => {
      const history = await slack.userClient!.conversations.history({
        channel: slack.secondChannelId,
        limit: 20,
      });
      return history.messages?.find((m) => m.bot_id && m.text?.includes(sent.marker)) ?? null;
    },
    { timeoutMs: timeoutSeconds * 1_000, label: `sent message in ${slack.secondChannelId}` },
  );

  expect(message, 'the bot posted the message in the second channel').toBeTruthy();
  expect(message!.text).toContain(`<@${sent.humanUserId}>`);
  // Slack stores the markdown block as rich text; a parsed mention is a user element.
  expect(JSON.stringify(message!.blocks)).toContain(`"user_id":"${sent.humanUserId}"`);
});

Then("the run's stored reply records the sent message", async () => {
  const replies = await getPrisma().conversationMessage.findMany({
    where: { role: 'AGENT' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { toolCalls: true },
  });
  const sendCall = replies
    .flatMap((m) => (Array.isArray(m.toolCalls) ? (m.toolCalls as Array<{ tool?: string; success?: boolean; input?: string }>) : []))
    .find((c) => c.tool === 'send_message' && c.success);
  expect(sendCall, 'a successful send_message call on a stored reply').toBeTruthy();
  expect(sendCall!.input).toContain(sent.marker);
});
