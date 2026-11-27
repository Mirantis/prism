/**
 * Memory-search step definitions.
 *
 * The entries are written straight into the database with no embedding, and both
 * fall outside the recent-memory window. A search by meaning finds neither, so the
 * agent can name the right one only through a time window on `memory_search`.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DAY_MS, DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

function agentRows() {
  return dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
  });
}

Given('the agent recorded {string} {int} day(s) ago', async ({}, content: string, days: number) => {
  await dbHelper.getPrisma().memoryEntry.create({
    data: {
      agentId: DEFAULT_AGENT_ID,
      content,
      category: 'observation',
      importance: 5,
      createdAt: new Date(Date.now() - days * DAY_MS),
    },
  });
});

When('I ask the agent what it recorded {int} days ago', async ({ page }, days: number) => {
  // The UTC date, the zone the agent's prompt gives the date in.
  const date = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const homePage = new HomePage(page);
  await homePage.typeMessage(`What did you record on ${date}?`);
  await homePage.sendMessage();
});

Then('no reply mentions {string}', async ({ page }, text: string) => {
  // Passes by finding nothing, so it waits for the turn to end first.
  await new HomePage(page).waitForStreamComplete();
  const replies = await agentRows();

  expect(replies.filter((r) => !r.internalStep).map((r) => r.content).join('\n')).not.toContain(text);
});

Then('the agent searched its memory from a start time', async () => {
  // Every AGENT row, hidden steps included: concise mode stores a tool round on an
  // internal row.
  const calls = (await agentRows()).flatMap((r) =>
    Array.isArray(r.toolCalls) ? (r.toolCalls as Array<{ tool: string; input: string; success: boolean }>) : [],
  );
  const windowed = calls.filter((c) => {
    if (c.tool !== 'memory_search' || !c.success) return false;
    const input = JSON.parse(c.input) as { since?: string };
    return Boolean(input.since);
  });

  expect(windowed.length, `memory_search calls: ${JSON.stringify(calls)}`).toBeGreaterThan(0);
});
