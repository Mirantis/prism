/**
 * Slack Heartbeat Trigger Step Definitions
 *
 * Exercises the path: Slack message arrives in a heartbeat-trigger
 * channel → agent-runtime drains the queue → heartbeat invocation runs →
 * bot posts a reply back to the channel.
 *
 * Reuses the @slack Before/After hook and the channel-setup Givens from
 * slack-channel.steps.ts via the shared slack-state module.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { getCurrentAgentId } from './common.steps';
import { getPrisma } from '../support/db-helper';
import { getSlackState } from '../support/slack-state';
import { pollUntil, waitForBotMessageInChannel } from '../support/slack-helper';
import { TEST_USER } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

let channelReplyText: string | null = null;

// ============================================================================
// Given
// ============================================================================

Given(
  'the channel is configured as a heartbeat trigger with throttle {int}',
  async ({}, throttleSeconds: number) => {
    const slack = getSlackState();

    // The Slack connection is synthesized from env by lib/slack-config.ts
    // with id === teamId, so SLACK_E2E_TEAM_ID is also the connectionId
    // the runtime expects.
    const connectionId = process.env.SLACK_E2E_TEAM_ID;
    if (!connectionId) {
      throw new Error('SLACK_E2E_TEAM_ID is not set — required for slack heartbeat e2e');
    }

    // No agent id in the path: this runtime owns exactly one agent, and the
    // single-agent refactor dropped the segment. The scenario has been skipped
    // ever since, so nothing caught the 404 until it ran again.
    const url = `${process.env.AGENT_RUNTIME_URL}/agents/slack-heartbeat-trigger`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId,
        channelId: slack.channelId,
        channelName: slack.channelName,
        userId: TEST_USER.id,
        throttleSeconds,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create heartbeat trigger (${res.status}): ${body}`);
    }
  },
);

// ============================================================================
// When
// ============================================================================

When('I post {string} in the channel', async ({}, text: string) => {
  const slack = getSlackState();
  const result = await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    text,
  });
  slack.messageTs = result.ts!;
});

// ============================================================================
// Then
// ============================================================================

Then(
  'the bot should post a reply in the channel within {int} seconds',
  async ({}, timeoutSeconds: number) => {
    const slack = getSlackState();
    channelReplyText = await waitForBotMessageInChannel(
      slack.userClient!,
      slack.channelId,
      slack.messageTs,
      timeoutSeconds * 1_000,
    );
    expect(channelReplyText).toBeTruthy();
    expect(channelReplyText!.trim().length).toBeGreaterThan(0);
  },
);

Then('a HEARTBEAT-triggered agent message exists for the agent', async () => {
  const agentId = getCurrentAgentId();
  // The adapter records the Slack message id once Slack has accepted the post, so the
  // reply can be in the channel a moment before its row holds the id.
  const message = await pollUntil(
    () =>
      getPrisma().conversationMessage.findFirst({
        where: {
          role: 'AGENT',
          triggeredBy: 'HEARTBEAT',
          thread: { agentId },
          externalMessageId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      }),
    { timeoutMs: 10_000, intervalMs: 250, label: 'the heartbeat reply recording its Slack message id' },
  );
  expect(message, 'no HEARTBEAT-triggered agent message has a Slack message id').toBeTruthy();
});
