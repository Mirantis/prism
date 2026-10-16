import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, Then } = createBdd();

Given('the main agent uses a saved Codex subscription', async () => {
  test.skip(process.env.LLM_PROVIDER !== 'codex-subscription', 'Run with LLM_PROVIDER=codex-subscription and a saved ChatGPT login.');
  expect(process.env.OPENAI_API_KEY || '').toBe('');
  expect(process.env.CODEX_API_KEY || '').toBe('');
});

Then('the subscription conversation used the Prism shell tool', async () => {
  const messages = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
  });
  const tools = messages.flatMap((message) => Array.isArray(message.toolCalls)
    ? (message.toolCalls as Array<{ tool?: string }>).map((call) => call.tool) : []);
  expect(tools).toContain('shell_exec');
});
