/**
 * Conversation search step definitions.
 *
 * The earlier conversation is seeded directly in the database, so the fact is in a
 * message and nowhere else: no memory entry holds it.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, Then } = createBdd();

let earlierThreadId = '';

Given('an earlier conversation where I said {string}', async ({}, text: string) => {
  earlierThreadId = await dbHelper.createThread(DEFAULT_AGENT_ID, {
    title: 'Staging notes',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    messages: [
      { role: 'USER', content: text },
      { role: 'AGENT', content: 'Noted.' },
    ],
  });
});

Then('the agent searched its conversations', async () => {
  const prisma = dbHelper.getPrisma();
  const thread = await prisma.conversationThread.findFirst({
    where: { agentId: DEFAULT_AGENT_ID, id: { not: earlierThreadId } },
    orderBy: { updatedAt: 'desc' },
  });
  expect(thread).not.toBeNull();
  const rows = await prisma.conversationMessage.findMany({ where: { threadId: thread!.id, role: 'AGENT' } });
  expect(rows.some((r) => JSON.stringify(r.toolCalls ?? '').includes('"search_conversations"'))).toBe(true);
});
