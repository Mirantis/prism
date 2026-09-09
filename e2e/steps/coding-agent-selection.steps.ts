import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID, E2E_WORKSPACE } from '../fixtures/test-data';
import { hasClaudeCodeCredentials } from '../../src/lib/coding-agents/claude-code/credentials';
import { codexAuthMethod } from '../../src/lib/coding-agents/codex/credentials';
import { getPrisma } from '../support/db-helper';
import type { ToolCallRecord } from '../../src/types';

const { Given, When, Then } = createBdd();
const filename = 'coding-agent-example.txt';
const file = path.join(E2E_WORKSPACE, filename);

Given('a coding task file contains {string}', async ({}, content: string) => {
  fs.writeFileSync(file, content);
});

When('I ask the coding agent to plan a change', async ({ page }) => {
  test.setTimeout(480_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent with model="small" and effort="low" in plan mode to read ${filename} and plan changing its contents to exactly after. ` +
    'Poll coding_agent_status until completed and retain its sessionId. Report the plan and sessionId.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
});

Then('the coding task file contains {string}', async ({}, content: string) => {
  expect(fs.readFileSync(file, 'utf8').trim()).toBe(content);
});

When('I ask the coding agent to implement its plan', async ({ page }) => {
  const home = new HomePage(page);
  await home.typeMessage(
    'Resume that coding_agent sessionId with model="medium" and effort="high" in edit mode to implement the plan. ' +
    'Poll coding_agent_status until completed. Report the result.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
});

async function codingCalls(): Promise<ToolCallRecord[]> {
  const rows = await getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap(row => Array.isArray(row.toolCalls)
    ? row.toolCalls as unknown as ToolCallRecord[] : []);
}

Then('the coding task completed through delegation', async ({ page }) => {
  const calls = await codingCalls();
  const starts = calls.filter(call => call.tool === 'coding_agent');
  expect(starts).toHaveLength(2);
  expect(JSON.parse(starts[0].input)).toMatchObject({ mode: 'plan', model: 'small', effort: 'low' });
  expect(JSON.parse(starts[1].input)).toMatchObject({ mode: 'edit', model: 'medium', effort: 'high', sessionId: expect.any(String) });
  const statuses = calls.filter(call => call.tool === 'coding_agent_status' && call.success)
    .map(call => JSON.parse(call.output));
  const plan = statuses.find(status => status.completed && status.stopReason === 'end_turn');
  expect(plan?.sessionId).toBeTruthy();
  expect(JSON.parse(starts[1].input).sessionId).toBe(plan.sessionId);
  if (process.env.CODING_AGENT) {
    expect(starts.map(call => JSON.parse(call.output).agent))
      .toEqual([process.env.CODING_AGENT, process.env.CODING_AGENT]);
  }
  await expect(new HomePage(page).getAgentMessages()).toHaveCount(2);
});

Given('both coding agents have test credentials', async () => {
  const hasBoth = hasClaudeCodeCredentials(process.env) &&
    codexAuthMethod(process.env);
  test.skip(!hasBoth, 'Agent selection needs credentials for both Claude Code and Codex.');
});

Given('Codex has a saved test login', async () => {
  test.skip(!process.env.CODEX_HOME || codexAuthMethod(process.env) !== 'saved',
    'Saved-login coverage needs CODEX_HOME with auth.json and empty API key environment variables.');
  expect(process.env.OPENAI_API_KEY).toBe('');
  expect(process.env.CODEX_API_KEY || '').toBe('');
});

When('I ask for a coding task using {string}', async ({ page }, agent: string) => {
  test.setTimeout(240_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent with agent="${agent}" in edit mode to change ${filename} to exactly after. ` +
    'Poll coding_agent_status until completed. Report which coding agent ran the task and its result.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
});

Then('the coding task used {string}', async ({ page }, agent: string) => {
  const calls = await codingCalls();
  const starts = calls.filter(call => call.tool === 'coding_agent');
  expect(starts).toHaveLength(1);
  expect(JSON.parse(starts[0].input).agent).toBe(agent);
  expect(starts[0].success).toBe(true);
  expect(JSON.parse(starts[0].output).agent).toBe(agent);
  expect(calls.filter(call => call.tool === 'coding_agent_status' && call.success)
    .map(call => JSON.parse(call.output)))
    .toContainEqual(expect.objectContaining({ agent, completed: true, stopReason: 'end_turn' }));
  await expect(new HomePage(page).getAgentMessages()).toHaveCount(1);
});
