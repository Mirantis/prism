/**
 * Slack File Sharing Step Definitions
 *
 * Inbound: a user uploads a file (mentioning the bot) and the agent reads it.
 * Outbound: the user asks the agent to create a file; the agent shares it back
 * via files.uploadV2 and it lands in the thread.
 *
 * Channel setup Givens ("a test Slack channel exists", "the bot is invited…",
 * "I link the channel…") and the @slack Before/After hooks are defined in
 * slack-channel.steps.ts and reused here via the shared slack-state singleton.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import {
  waitForBotReply,
  uploadFileToChannel,
  waitForBotFileInThread,
  downloadSlackFileText,
  type SlackSharedFile,
} from '../support/slack-helper';
import { getSlackState } from '../support/slack-state';

const { When, Then } = createBdd();

// Tests run sequentially (workers: 1), so module-level handles are safe.
let fileReplyText: string | null = null;
let sharedFile: SlackSharedFile | null = null;

// ============================================================================
// Inbound — the agent reads an uploaded file
// ============================================================================

When(
  'I upload a file named {string} containing {string} mentioning the bot {string}',
  async ({}, filename: string, content: string, mention: string) => {
    const slack = getSlackState();
    // The initial_comment carries the bot mention so the channel handler
    // treats the file-share as addressed to the agent.
    slack.messageTs = await uploadFileToChannel(slack.userClient!, slack.channelId, {
      filename,
      content,
      initialComment: `<@${slack.botUserId}> ${mention}`,
    });
  },
);

Then('the bot should reply about the file within {int} seconds', async ({}, timeoutSeconds: number) => {
  const slack = getSlackState();
  fileReplyText = await waitForBotReply(
    slack.userClient!,
    slack.channelId,
    slack.messageTs,
    timeoutSeconds * 1_000,
  );
  expect(fileReplyText, 'bot did not reply to the uploaded file in time').toBeTruthy();
});

Then('the file reply should contain {string}', async ({}, expected: string) => {
  expect(fileReplyText, 'no bot reply captured — run the reply step first').toBeTruthy();
  expect(fileReplyText!).toContain(expected);
});

// ============================================================================
// Outbound — the agent creates a file and shares it back
// (the mention is sent via slack-channel.steps' "I send a message mentioning
//  the bot {string}", which stores the mention ts in slack.messageTs)
// ============================================================================

Then(
  'the bot should share a file named {string} in the thread within {int} seconds',
  async ({}, filename: string, timeoutSeconds: number) => {
    const slack = getSlackState();
    sharedFile = await waitForBotFileInThread(
      slack.userClient!,
      slack.channelId,
      slack.messageTs,
      filename,
      slack.botUserId,
      timeoutSeconds * 1_000,
    );
    expect(sharedFile, `bot did not share "${filename}" in the thread in time`).toBeTruthy();
  },
);

Then('the shared file should contain {string}', async ({}, expected: string) => {
  expect(sharedFile, 'no shared file captured — run the share step first').toBeTruthy();
  const text = await downloadSlackFileText(sharedFile!, process.env.SLACK_E2E_USER_TOKEN!);
  expect(text).toContain(expected);
});
