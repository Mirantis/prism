/**
 * Coding sub-agent step definitions. The scenarios run the real coding agent
 * (Claude Code on the runtime's Bedrock token), so they need the `claude` CLI on
 * PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { ActivityPage } from '../pages/activity.page';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID, E2E_DATA_DIR, E2E_WORKSPACE } from '../fixtures/test-data';


const { Given, Then, After } = createBdd();

/** The files a scenario wrote, removed again after it. */
let written: string[] = [];

After(async () => {
  for (const file of written) fs.rmSync(file, { force: true });
  written = [];
});

Given('the coding agent\'s settings deny writing {string}', async ({}, filename: string) => {
  // An operator's own CLAUDE_CONFIG_DIR is their real home, which a test must
  // not write into.
  test.skip(Boolean(process.env.CLAUDE_CONFIG_DIR), 'CLAUDE_CONFIG_DIR points at a real Claude Code home.');
  fs.rmSync(path.join(E2E_WORKSPACE, filename), { force: true });
  // The runtime's Claude Code home, with no CLAUDE_CONFIG_DIR set.
  const home = path.join(E2E_DATA_DIR, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const settings = path.join(home, 'settings.json');
  written.push(settings);
  // A deny rule refuses the action in every permission mode, so the refusal
  // does not depend on what the auto-mode classifier makes of the request.
  fs.writeFileSync(settings, JSON.stringify({
    permissions: { deny: [`Write(**/${filename})`, `Edit(**/${filename})`] },
  }));
});

Given(
  'the workspace\'s .mcp.json has a server {string} that answers {string}',
  async ({}, name: string, marker: string) => {
    fs.mkdirSync(E2E_WORKSPACE, { recursive: true });
    const server = path.join(__dirname, '..', 'fixtures', 'plugin-mcp-probe.mjs');
    const config = path.join(E2E_WORKSPACE, '.mcp.json');
    written.push(config);
    fs.writeFileSync(config, JSON.stringify({
      mcpServers: { [name]: { type: 'stdio', command: 'node', args: [server, [...marker].reverse().join('')] } },
    }));
  },
);

Then('the activity shows a {string} tool call', async ({ page, $testInfo }, label: string) => {
  await expect(
    new ActivityPage(page).toolCalls.getByText(label, { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: $testInfo.outputPath('coding-agent-activity.png'), fullPage: true });
});

/** Tool calls stored on the agent's messages, across every thread the scenario made. */
async function storedToolCalls(): Promise<Array<{ tool?: string; input?: string; output?: string }>> {
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.flatMap((row) =>
    Array.isArray(row.toolCalls) ? (row.toolCalls as Array<{ tool?: string; input?: string; output?: string }>) : [],
  );
}

/** Tool names stored on the agent's messages, across every thread the scenario made. */
async function storedToolNames(): Promise<string[]> {
  return (await storedToolCalls()).map((tc) => tc.tool ?? '');
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
  'the coding task reports a refused {string} of {string}',
  async ({}, action: string, filename: string) => {
    const statuses = (await storedToolCalls())
      .filter((call) => call.tool === 'coding_agent_status' && call.output)
      .map((call) => JSON.parse(call.output as string) as {
        completed?: boolean;
        stopReason?: string;
        result?: string;
        refusals?: Array<{ action: string; target: string }>;
      });
    const done = statuses.find((status) => status.completed);
    expect(done?.stopReason).toBe('refused');
    // The CLI names the file by its absolute path, which may be the temp dir's real path.
    const refused = done?.refusals?.find((r) => r.action === action && r.target.endsWith(`/${filename}`));
    expect(refused, JSON.stringify(done?.refusals)).toBeTruthy();
    expect(done?.result).toContain(`- ${action}: ${refused?.target}`);
  },
);

Then('the workspace has no file {string}', async ({}, filename: string) => {
  expect(fs.existsSync(path.join(E2E_WORKSPACE, filename))).toBe(false);
});

Then(
  'the stored tool calls include {string} and {string}',
  async ({}, first: string, second: string) => {
    const names = await storedToolNames();
    expect(names).toContain(first);
    expect(names).toContain(second);
  },
);

Then('the stored tool calls do not include {string}', async ({}, name: string) => {
  expect(await storedToolNames()).not.toContain(name);
});

/** The task notifications stored in the scenario's conversations, oldest first. */
function taskNotifications() {
  return dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, triggeredBy: 'TASK_NOTIFICATION' },
    orderBy: { createdAt: 'asc' },
  });
}

/** The first delivered agent reply that contains `text`. */
async function replyContaining(text: string) {
  const replies = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
    orderBy: { createdAt: 'asc' },
  });
  const reply = replies.find((row) => row.content.includes(text));
  expect(reply, `no reply contains ${text}`).toBeTruthy();
  return reply!;
}

Then("the coding task's result reaches the conversation as a task notification", async () => {
  // The task is a real Claude Code run, so its start alone can take a minute.
  await expect.poll(async () => (await taskNotifications()).length, { timeout: 240_000, intervals: [2_000] }).toBe(1);
  const [notification] = await taskNotifications();
  // Hidden: the model reads it, and no client shows it.
  expect(notification.internalStep).toBe(true);
  expect(notification.role).toBe('USER');
  expect(notification.content).toContain('<task-notification ');
});

Then(
  'an agent reply after the task notification contains {string} within {int} seconds',
  async ({}, text: string, seconds: number) => {
    await expect.poll(async () => (await taskNotifications()).length, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(0);
    const [notification] = await taskNotifications();
    const after = () =>
      dbHelper.getPrisma().conversationMessage.findFirst({
        where: {
          thread: { agentId: DEFAULT_AGENT_ID },
          role: 'AGENT',
          internalStep: false,
          createdAt: { gt: notification.createdAt },
          content: { contains: text },
        },
      });
    await expect.poll(after, { timeout: seconds * 1_000, intervals: [1_000] }).not.toBeNull();
    const reply = await after();
    expect(reply!.createdAt.getTime() - notification.createdAt.getTime()).toBeLessThan(seconds * 1_000);
  },
);

Then('the reply with {string} came before the task notification', async ({}, text: string) => {
  const reply = await replyContaining(text);
  const [notification] = await taskNotifications();
  if (notification) expect(reply.createdAt.getTime()).toBeLessThan(notification.createdAt.getTime());
});

Then('the agent set no timer for the coding task', async () => {
  const calls = await storedToolCalls();
  const commands = calls
    .filter((call) => call.tool === 'shell_exec' || call.tool === 'shell_spawn')
    .map((call) => String(call.input ?? ''));
  expect(commands.filter((command) => /\bsleep\b/.test(command))).toEqual([]);
  expect(calls.map((call) => call.tool)).not.toContain('schedule_task');
  expect(calls.filter((call) => call.tool === 'coding_agent_status').length).toBeLessThanOrEqual(1);
});
