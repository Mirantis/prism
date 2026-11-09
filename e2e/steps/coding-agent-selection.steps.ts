import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID, E2E_WORKSPACE } from '../fixtures/test-data';
import { hasClaudeCodeCredentials } from '../../src/lib/coding-agents/claude-code/credentials';
import { readSavedLogin } from '../../src/lib/coding-agents/claude-code/authenticated-home';
import { getExecutionEnvironment } from '../../src/lib/execution-environments/get-execution-environment';
import { codexAuthMethod, readCodexLogin } from '../../src/lib/coding-agents/codex/credentials';
import { isAnthropicModelId, isOpenAiBedrockModelId } from '../../src/lib/llm-providers/bedrock-model-id';
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
  const hasBoth = (await hasClaudeCodeCredentials(process.env)) &&
    codexAuthMethod(process.env);
  test.skip(!hasBoth, 'Agent selection needs credentials for both Claude Code and Codex.');
});

Given('Codex has a saved test login', async () => {
  test.skip(!process.env.CODEX_HOME || codexAuthMethod(process.env) !== 'saved',
    'Saved-login coverage needs CODEX_HOME with auth.json and empty API key environment variables.');
  expect(process.env.OPENAI_API_KEY).toBe('');
  expect(process.env.CODEX_API_KEY || '').toBe('');
});

Given('Claude Code has a saved subscription login', async () => {
  // Read on this machine, where the runtime's tasks run unless they run in its container.
  test.skip(process.env.EXECUTION_ENVIRONMENT === 'docker',
    'The container keeps its own Claude home, which this process cannot read.');
  const home = process.env.CLAUDE_CONFIG_DIR ?? '';
  const needs = 'Subscription coverage needs CLAUDE_CODE_SUBSCRIPTION=true and CLAUDE_CONFIG_DIR signed in to a Claude subscription with claude auth login.';
  test.skip(!home || process.env.CLAUDE_CODE_SUBSCRIPTION !== 'true', needs);
  // This worker has no SHELL_WORKSPACE_ROOT, so its workspace root is /home/node,
  // which a host may not have. The probe runs in the runtime's workspace instead.
  // Opted in, a probe that gives no answer fails the scenario rather than skipping it.
  const login = await readSavedLogin({ ...getExecutionEnvironment(), workspaceRoot: () => E2E_WORKSPACE }, process.env, home);
  test.skip(login !== 'subscription', needs);
});

Given('Codex has a saved ChatGPT login', async () => {
  test.skip(process.env.EXECUTION_ENVIRONMENT === 'docker',
    'The container keeps its own Codex home, which this process cannot read.');
  const home = process.env.CODEX_HOME ?? '';
  const needs = 'Subscription coverage needs CODEX_SUBSCRIPTION=true and CODEX_HOME signed in to ChatGPT with codex login.';
  test.skip(!home || process.env.CODEX_SUBSCRIPTION !== 'true', needs);
  // Read in the runtime's workspace, for the reason the Claude step gives.
  const login = await readCodexLogin({ ...getExecutionEnvironment(), workspaceRoot: () => E2E_WORKSPACE }, process.env, home);
  test.skip(login !== 'chatgpt', needs);
});

async function askHowClaudeCodeIsSignedIn(page: Page, model?: string): Promise<void> {
  test.setTimeout(240_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent with agent="claude-code"${model ? ` and model="${model}"` : ''} in edit mode, giving it this prompt: ` +
    'Run the shell command `claude auth status --json` and reply with only the value of its authMethod field. ' +
    'Poll coding_agent_status until completed. Reply with one line only: AUTH=<the result>.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
}

When('I ask a Claude Code task how it is signed in', async ({ page }) => {
  await askHowClaudeCodeIsSignedIn(page);
});

// The runtime Playwright starts inherits this process's env (see the README on a stopped runtime).
Given("Claude Code's small model is a Bedrock ID", async () => {
  test.skip(!isAnthropicModelId(process.env.CLAUDE_CODE_MODEL_SMALL ?? ''),
    'Needs CLAUDE_CODE_MODEL_SMALL set to a Bedrock ID, such as eu.anthropic.claude-haiku-5-5.');
});

When('I ask a Claude Code task on the {string} model how it is signed in', async ({ page }, model: string) => {
  await askHowClaudeCodeIsSignedIn(page, model);
});

Then('the coding task is signed in with {string}', async ({}, method: string) => {
  const statuses = (await codingCalls())
    .filter(call => call.tool === 'coding_agent_status' && call.success)
    .map(call => JSON.parse(call.output));
  expect(statuses).toContainEqual(expect.objectContaining({
    agent: 'claude-code',
    completed: true,
    stopReason: 'end_turn',
    result: expect.stringContaining(method),
  }));
});

async function askForCodingTask(page: Page, agent: string, model?: string): Promise<void> {
  test.setTimeout(240_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent with agent="${agent}"${model ? ` and model="${model}"` : ''} in edit mode ` +
    `to change ${filename} to exactly after. ` +
    'Poll coding_agent_status until completed. Report which coding agent ran the task and its result.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(180_000);
}

When('I ask for a coding task using {string}', async ({ page }, agent: string) => {
  await askForCodingTask(page, agent);
});

// The runtime Playwright starts inherits this process's env, as for Claude Code above.
Given("Codex's small model is a Bedrock ID", async () => {
  test.skip(!isOpenAiBedrockModelId(process.env.CODEX_MODEL_SMALL ?? ''),
    'Needs CODEX_MODEL_SMALL set to a Bedrock ID, such as openai.gpt-5.6-luna.');
});

When('I ask for a coding task using {string} on the {string} model', async ({ page }, agent: string, model: string) => {
  await askForCodingTask(page, agent, model);
});

Then('the coding task asked for the {string} model', async ({}, model: string) => {
  const starts = (await codingCalls()).filter(call => call.tool === 'coding_agent');
  expect(starts).toHaveLength(1);
  expect(JSON.parse(starts[0].input).model).toBe(model);
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
