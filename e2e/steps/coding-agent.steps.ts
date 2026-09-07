/**
 * Coding sub-agent step definitions. The scenario runs the real coding agent
 * (Claude Code on the runtime's Bedrock token), so it needs the `claude` CLI on
 * PATH.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { ActivityPage } from '../pages/activity.page';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Then } = createBdd();

Then('the activity shows a {string} tool call', async ({ page, $testInfo }, label: string) => {
  await expect(
    new ActivityPage(page).toolCalls.getByText(label, { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: $testInfo.outputPath('coding-agent-activity.png'), fullPage: true });
});

/** Tool names stored on the agent's messages, across every thread the scenario made. */
async function storedToolNames(): Promise<string[]> {
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
  });
  return rows.flatMap((row) =>
    Array.isArray(row.toolCalls)
      ? (row.toolCalls as Array<{ tool?: string }>).map((tc) => tc.tool ?? '')
      : [],
  );
}

Then('the conversation shows a {string} tool call', async ({ page, $testInfo }, label: string) => {
  const homePage = new HomePage(page);
  await homePage.waitForStreamComplete();
  // Tool calls sit behind each message's "N tools used" toggle; open them all.
  const toggles = page.getByTestId('chat-messages').getByText(/\d+ tools? used/);
  const count = await toggles.count();
  for (let i = 0; i < count; i++) await toggles.nth(i).click();
  await expect(
    page.getByTestId('chat-messages').getByText(label, { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: $testInfo.outputPath('coding-agent-chat.png'), fullPage: true });
});

Then(
  'the stored tool calls include {string} and {string}',
  async ({}, first: string, second: string) => {
    const names = await storedToolNames();
    expect(names).toContain(first);
    expect(names).toContain(second);
  },
);
