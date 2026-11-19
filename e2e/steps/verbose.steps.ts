/**
 * Verbose / concise delivery mode step definitions.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

interface MessagePayload { id: string; role: string; step?: boolean }

/** The `message` events the chat socket delivered in the last turn, in arrival order, one per id. */
let delivered: MessagePayload[] = [];

function agentMessages(messages: MessagePayload[]): MessagePayload[] {
  return messages.filter((message) => message.role === 'AGENT');
}

/** The marks of a turn's agent messages: every one but the reply is a step. */
function expectStepsThenReply(messages: MessagePayload[]): void {
  const marks = agentMessages(messages).map((message) => message.step);
  expect(marks.length).toBeGreaterThan(1);
  expect(marks).toEqual([...Array(marks.length - 1).fill(true), false]);
}

/** The latest thread's client history, read from the runtime: the SPA's dev server proxies only `/agents`. */
async function history(page: Page): Promise<MessagePayload[]> {
  const res = await page.request.get(`${process.env.AGENT_RUNTIME_URL}/messages?limit=50`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as MessagePayload[];
}

Given('the agent is in concise mode', async () => {
  const prisma = dbHelper.getPrisma();
  await prisma.agentWorkspace.update({
    where: { id: DEFAULT_AGENT_ID },
    data: { verbose: false },
  });
});

Given('the agent is in verbose mode', async () => {
  const prisma = dbHelper.getPrisma();
  await prisma.agentWorkspace.update({
    where: { id: DEFAULT_AGENT_ID },
    data: { verbose: true },
  });
});

When('a multi-step chat turn completes', async ({ page }) => {
  delivered = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      let frame: { type?: string; payload?: MessagePayload };
      try { frame = JSON.parse(payload); } catch { return; }
      const message = frame.payload;
      if (frame.type !== 'message' || !message?.id) return;
      delivered = [...delivered.filter((seen) => seen.id !== message.id), message];
    });
  });
  const homePage = new HomePage(page);
  await homePage.navigate();
  // Coerce a genuine intermediate text step: narrate, then use a tool, then a
  // separate final reply. Without the narration the model may go straight to a
  // single final step and the "multiple AGENT rows" premise wouldn't hold.
  await homePage.typeMessage(
    'First tell me in one short sentence that you are about to run a command. ' +
      'Then use your shell to run `echo web-e2e-marker`. ' +
      'Then send a separate final message telling me what it printed.',
  );
  await homePage.sendMessage();
  await homePage.waitForStreamComplete();
});

Then('only one agent message is delivered via the channel', async ({ page }) => {
  const homePage = new HomePage(page);
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages).toHaveCount(1, { timeout: 15_000 });
});

Then('the database contains multiple AGENT rows for the thread', async () => {
  const prisma = dbHelper.getPrisma();
  const count = await prisma.conversationMessage.count({
    where: { role: 'AGENT' },
  });
  expect(count).toBeGreaterThan(1);
});

Then('the intermediate steps are flagged internal in the database', async () => {
  const prisma = dbHelper.getPrisma();
  // Fidelity claim: intermediate rows are persisted AND marked internalStep, while
  // the delivered final row is not — so the model still replays everything but the
  // client hides the intermediates.
  const internal = await prisma.conversationMessage.count({
    where: { role: 'AGENT', internalStep: true },
  });
  const delivered = await prisma.conversationMessage.count({
    where: { role: 'AGENT', internalStep: false },
  });
  expect(internal).toBeGreaterThan(0);
  expect(delivered).toBeGreaterThan(0);
});

Then('the agent message shows the tool calls of the hidden steps', async ({ page }) => {
  // The narration step that ran the shell command is hidden, and its call has to
  // reach the one message shown, live and after a reload.
  const prisma = dbHelper.getPrisma();
  const hidden = await prisma.conversationMessage.findMany({
    where: { role: 'AGENT', internalStep: true },
    select: { toolCalls: true },
  });
  const tools = hidden.flatMap((row) =>
    Array.isArray(row.toolCalls) ? (row.toolCalls as Array<{ tool: string }>).map((tc) => tc.tool) : [],
  );
  expect(tools.length).toBeGreaterThan(0);

  const message = new HomePage(page).getAgentMessages().last();
  await message.getByText(/\d+ tools? used/).click();
  // The card renders the tool name as formatToolLabel does, e.g. shell_exec -> Shell Exec.
  for (const tool of new Set(tools)) {
    const label = tool
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    await expect(message.getByText(label, { exact: true }).first()).toBeVisible();
  }
});

// Note: the "I reload the chat page" step is defined once in file-sharing.steps.ts
// and shared across features — don't redefine it here (playwright-bdd errors on
// duplicate step definitions).

Then('only one agent message is shown', async ({ page }) => {
  const homePage = new HomePage(page);
  // The reported bug: after a reload (getThread refetch), suppressed intermediate
  // rows used to reappear. They must stay hidden.
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages).toHaveCount(1, { timeout: 15_000 });
});

Then('the delivered agent message arrives unmarked', async () => {
  const marks = agentMessages(delivered).map((message) => message.step);
  expect(marks).toEqual([false]);
});

Then('the history marks no agent message as a step', async ({ page }) => {
  const marks = agentMessages(await history(page)).map((message) => message.step);
  expect(marks.length).toBeGreaterThan(0);
  expect(marks.every((step) => step === false)).toBe(true);
});

Then('every delivered agent message but the reply arrives marked as a step', async () => {
  await expect.poll(() => agentMessages(delivered).at(-1)?.step, { timeout: 30_000 }).toBe(false);
  expectStepsThenReply(delivered);
});

Then('the history marks every agent message but the reply as a step', async ({ page }) => {
  expectStepsThenReply(await history(page));
});

Then('multiple agent messages are delivered via the channel', async ({ page }) => {
  const homePage = new HomePage(page);
  const agentMessages = homePage.getAgentMessages();
  // Poll rather than reading a single count: the steps stream in one at a time,
  // so a bare count() races the tail of the turn.
  await expect
    .poll(() => agentMessages.count(), { timeout: 30_000 })
    .toBeGreaterThan(1);
});

Then('the agent details show verbose is true', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.verbose).toBe(true);
});

Then('the agent details show verbose is false', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.verbose).toBe(false);
});

When('I toggle verbose to true', async ({ page }) => {
  // Match by role+accessible name (as webhooks.page.ts does). Base UI renders
  // the switch as <span role="switch">, so the aria-label is the accessible
  // name — not a <label> association.
  const toggle = page.getByRole('switch', { name: 'Verbose delivery' });
  await toggle.click();
  await page.waitForTimeout(500);
});

When('I toggle verbose to false', async ({ page }) => {
  // Match by role+accessible name (as webhooks.page.ts does). Base UI renders
  // the switch as <span role="switch">, so the aria-label is the accessible
  // name — not a <label> association.
  const toggle = page.getByRole('switch', { name: 'Verbose delivery' });
  await toggle.click();
  await page.waitForTimeout(500);
});
