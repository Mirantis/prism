/**
 * Reading a web page. The page is public, because web_fetch refuses a loopback
 * address and the runtime under test is on one.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { When, Then } = createBdd();

When('I ask the agent what the page at {string} says', async ({ page }, url: string) => {
  const homePage = new HomePage(page);
  await homePage.typeMessage(`What does the page at ${url} say? Quote its first sentence.`);
  await homePage.sendMessage();
});

Then('the agent read the page with web_fetch and no other tool', async ({ page }) => {
  await new HomePage(page).waitForStreamComplete();
  // Every AGENT row, hidden steps included: concise mode stores a tool round on an
  // internal row.
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
  });
  const calls = rows.flatMap((r) =>
    Array.isArray(r.toolCalls) ? (r.toolCalls as Array<{ tool: string; input: string }>) : [],
  );
  const tools = calls.map((c) => c.tool);

  // No other tool at all, so a fallback to the browser or to `curl` after the read fails too.
  expect(tools, `tool calls: ${JSON.stringify(calls)}`).toContain('web_fetch');
  expect(tools.filter((tool) => tool !== 'web_fetch'), `tool calls: ${JSON.stringify(calls)}`).toEqual([]);
});
