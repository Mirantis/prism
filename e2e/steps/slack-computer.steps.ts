import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { SLACK_COMPUTER_PUBLIC_URL } from '../fixtures/test-data';
import { getSlackState } from '../support/slack-state';
import { pollUntil } from '../support/slack-helper';

const { Then } = createBdd();

Then('the Slack help message links to the configured public Computer page', async () => {
  const slack = getSlackState();
  const helpMessage = await pollUntil(
    async () => {
      const replies = await slack.userClient!.conversations.replies({
        channel: slack.channelId,
        ts: slack.messageTs,
        limit: 100,
      });
      return replies.messages?.find(
        (message) => message.user === slack.botUserId && message.text?.includes('/computer?help='),
      );
    },
    { timeoutMs: 90_000, label: 'Computer help link in Slack' },
  );
  expect(helpMessage, 'No Computer help link arrived in the Slack thread').toBeTruthy();
  expect(helpMessage!.text).toContain(`${SLACK_COMPUTER_PUBLIC_URL}/computer?help=`);
  expect(helpMessage!.text).toMatch(/computer\?help=[a-f0-9-]{36}/);
});
