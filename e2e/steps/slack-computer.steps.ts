import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { DEFAULT_AGENT_ID, SLACK_COMPUTER_PUBLIC_URL } from '../fixtures/test-data';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getSlackState } from '../support/slack-state';
import { pollUntil, waitForBotReply } from '../support/slack-helper';

const { Given, When, Then } = createBdd();

/** The request a run with no conversation posted, as its Slack link names it. */
let broadcastHelpId = '';

async function storedHelp(id: string) {
  const row = await dbHelper.getPrisma().conversationMessage.findFirst({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, blocks: { path: '$[0].id', equals: id } },
  });
  expect(row, `No stored help request ${id}`).toBeTruthy();
  const [help] = row!.blocks as Array<{
    threadId: string;
    status: string;
    broadcast?: boolean;
    originChannel?: string;
  }>;
  return help;
}

/**
 * The help requests the agent's top-level posts in the channel link to. A run's own result
 * can quote the link of the request it made, so this counts requests, not posts.
 */
async function helpIdsInChannel(): Promise<string[]> {
  const slack = getSlackState();
  const history = await slack.userClient!.conversations.history({ channel: slack.channelId, limit: 50 });
  const ids = (history.messages ?? [])
    .filter((message) => message.user === slack.botUserId)
    .flatMap((message) => [...(message.text ?? '').matchAll(/computer\?help=([a-f0-9-]{36})/g)])
    .map((match) => match[1]);
  return [...new Set(ids)];
}

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

Then('the help request is posted in the main Slack channel with the Computer link', async () => {
  const slack = getSlackState();
  const post = await pollUntil(
    async () => {
      const history = await slack.userClient!.conversations.history({
        channel: slack.channelId,
        limit: 50,
      });
      return history.messages?.find(
        (message) => message.user === slack.botUserId && message.text?.includes('/computer?help='),
      );
    },
    { timeoutMs: 300_000, label: 'Computer help request in the main channel' },
  );
  expect(post, 'No Computer help request arrived in the main channel').toBeTruthy();
  expect(post!.text).toContain(`${SLACK_COMPUTER_PUBLIC_URL}/computer?help=`);
  broadcastHelpId = post!.text!.match(/computer\?help=([a-f0-9-]{36})/)![1];
  slack.messageTs = post!.ts!;
});

Then('the same help request waits in the web chat', async ({ page }) => {
  const help = await storedHelp(broadcastHelpId);
  expect(help).toMatchObject({ status: 'waiting', broadcast: true });
  await page.goto(`/chat/${help.threadId}`);
  await expect(page.getByText(/Prism needs a sign-in|Computer help requested/).first()).toBeVisible();
  // The run waits for the answer, and a run that waits is not working, so the
  // conversation offers no Stop. The socket's welcome sets that state before the
  // composer is enabled.
  const home = new HomePage(page);
  await expect(home.chatInput).toBeEnabled();
  await expect(home.stopButton).toHaveCount(0);
});

When('I tell Prism in the Slack thread that I finished helping', async () => {
  const slack = getSlackState();
  await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    thread_ts: slack.messageTs,
    text: `<@${slack.botUserId}> I finished helping with the computer.`,
  });
});

Then('the web chat shows the help request answered', async ({ page }) => {
  // The page stays open from the step before, so the change has to arrive by itself.
  await expect(page.getByRole('status', { name: 'Computer help status' })).toContainText(
    'Computer help completed',
    { timeout: 240_000 },
  );
  expect((await storedHelp(broadcastHelpId)).status).toBe('continued');
});

Then('the help request that is already waiting is not posted again', async ({ page }) => {
  // The second run meets the waiting request and waits for the same answer.
  await expect
    .poll(
      async () => {
        const status = (await (await page.request.get('/agents/computer')).json()) as {
          awaitingHelp: Array<{ helpId: string; mode: string }>;
        };
        return status.awaitingHelp;
      },
      { timeout: 300_000, intervals: [2_000] },
    )
    .toEqual([
      expect.objectContaining({ helpId: broadcastHelpId, mode: 'cron' }),
      expect.objectContaining({ helpId: broadcastHelpId, mode: 'cron' }),
    ]);
  expect(await helpIdsInChannel()).toEqual([broadcastHelpId]);
  const requests = await dbHelper.getPrisma().conversationMessage.findMany({
    where: {
      thread: { agentId: DEFAULT_AGENT_ID },
      blocks: { path: '$[0].broadcast', equals: true },
    },
  });
  expect(requests.map((row) => (row.blocks as Array<{ id: string }>)[0].id)).toEqual([broadcastHelpId]);
  expect((await storedHelp(broadcastHelpId)).status).toBe('waiting');
});

Then('both scheduled tasks report the approved page in the main Slack channel', async ({ page }) => {
  const slack = getSlackState();
  await expect
    .poll(
      async () => {
        const history = await slack.userClient!.conversations.history({ channel: slack.channelId, limit: 50 });
        return (history.messages ?? []).filter(
          (message) => message.user === slack.botUserId && message.text?.includes('REPORT-READY'),
        ).length;
      },
      { timeout: 300_000, intervals: [3_000] },
    )
    .toBeGreaterThanOrEqual(2);
  const status = (await (await page.request.get('/agents/computer')).json()) as { awaitingHelp: unknown[] };
  expect(status.awaitingHelp).toEqual([]);
});

Given('a conversation with the bot in a Slack thread', async () => {
  const slack = getSlackState();
  const result = await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    text: `<@${slack.botUserId}> Reply with the single word ready.`,
  });
  slack.messageTs = result.ts!;
  expect(await waitForBotReply(slack.userClient!, slack.channelId, slack.messageTs, 90_000)).toBeTruthy();
});

Then("the goal's help request is posted in that Slack thread only", async () => {
  const slack = getSlackState();
  const post = await pollUntil(
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
    { timeoutMs: 300_000, label: "the goal's help request in the Slack thread" },
  );
  expect(post, "No help request arrived in the goal's Slack thread").toBeTruthy();
  const id = post!.text!.match(/computer\?help=([a-f0-9-]{36})/)![1];
  const help = await storedHelp(id);
  expect(help.originChannel).toBe('slack');
  expect(help.broadcast).toBeUndefined();
  // The main channel shows the thread's parent, not a broadcast copy of the request.
  expect(await helpIdsInChannel()).toEqual([]);
});
