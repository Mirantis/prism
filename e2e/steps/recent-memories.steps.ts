/**
 * Recent-memory step definitions.
 *
 * The entries are written straight into the database with no embedding, so the
 * per-turn recall cannot find them: what the agent knows of them came from the
 * block that opens the conversation. The block itself is asserted on the stored
 * row, and the reply on what the agent said with it. A voice session stores
 * nothing, so its block is asserted on the items the stand-in voice model received.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';
import { describeBrowser, waitForModel } from '../support/voice-model';

const { Given, Then } = createBdd();

const RECENT_BLOCK_OPENING = '\n\nContext:\n<recent-memories>\n';

async function latestThread() {
  const thread = await dbHelper.getPrisma().conversationThread.findFirst({
    where: { agentId: DEFAULT_AGENT_ID },
    orderBy: { createdAt: 'desc' },
  });
  expect(thread).not.toBeNull();
  return thread!;
}

Given('the agent recorded {string} {int} hour(s) ago', async ({}, content: string, hours: number) => {
  await dbHelper.getPrisma().memoryEntry.create({
    data: {
      agentId: DEFAULT_AGENT_ID,
      content,
      category: 'observation',
      importance: 5,
      createdAt: new Date(Date.now() - hours * 60 * 60 * 1000),
    },
  });
});

Then(
  'the conversation opened with one recent-memory block holding {string} and not {string}',
  async ({}, held: string, left: string) => {
    const thread = await latestThread();
    const blocks = await dbHelper.getPrisma().conversationMessage.findMany({
      where: { threadId: thread.id, internalStep: true, content: { startsWith: RECENT_BLOCK_OPENING } },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain(held);
    expect(blocks[0].content).not.toContain(left);
  },
);

Then('the conversation history shows me no recent-memory block', async ({ page }) => {
  // The history the web UI reads.
  const thread = await latestThread();
  const response = await page.request.get(
    `/agents/threads/${thread.id}?userId=${encodeURIComponent(thread.userId)}&agentId=${DEFAULT_AGENT_ID}`,
  );
  expect(response.ok()).toBe(true);
  const { messages } = (await response.json()) as { messages: Array<{ content: string }> };

  expect(messages.length).toBeGreaterThan(0);
  expect(messages.some((m) => m.content.includes('<recent-memories>'))).toBe(false);
});

Then('the voice session opened holding {string}', async ({}, held: string) => {
  await waitForModel(
    `a recent-memory item holding ${held}`,
    (state) => state.contextText.includes(`<recent-memories>\n- ${held}`),
    async () => describeBrowser(),
  );
});
