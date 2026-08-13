/**
 * Verbose / concise delivery mode step definitions.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

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

Then('the delivered message lists the tool calls the turn ran', async ({ page }) => {
  const homePage = new HomePage(page);
  // Concise mode hides the steps that made the calls, so the one delivered
  // message is the only place the turn's tool use can appear.
  const message = homePage.getAgentMessages().first();
  const trigger = message.getByTestId('chat-tool-calls');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await expect(trigger).toContainText(/\d+ tools? used/);
  await trigger.click();
  // A per-call row previews the command the hidden step ran. Targeted by testid
  // rather than text: the reply itself may quote the same command.
  await expect(
    message.getByTestId('chat-tool-call').filter({ hasText: 'echo web-e2e-marker' }).first(),
  ).toBeVisible();
});

Then("the delivered row carries the hidden steps' calls as summary copies", async () => {
  const prisma = dbHelper.getPrisma();
  const rows = await prisma.conversationMessage.findMany({
    where: { role: 'AGENT' },
    orderBy: { createdAt: 'asc' },
  });
  type Call = { tool: string; summary?: boolean };
  const callsOf = (toolCalls: unknown): Call[] => (Array.isArray(toolCalls) ? (toolCalls as Call[]) : []);

  const internalCalls = rows.filter((r) => r.internalStep).flatMap((r) => callsOf(r.toolCalls));
  const delivered = rows.filter((r) => !r.internalStep);
  expect(delivered).toHaveLength(1);
  const deliveredCalls = callsOf(delivered[0].toolCalls);

  // Premise: the multi-step prompt puts at least one call on a hidden row (the
  // narration step carries the shell call). Without it this scenario proves
  // nothing — fail loudly rather than pass vacuously.
  expect(internalCalls.length).toBeGreaterThan(0);

  // The fix: every call recorded on a hidden row reappears on the delivered
  // message, marked as a display-only summary copy.
  for (const tc of internalCalls) {
    expect(deliveredCalls).toContainEqual(expect.objectContaining({ tool: tc.tool, summary: true }));
  }

  // And only copies are marked: a summary flag on a call stored nowhere else
  // would delete that tool round from the model's replayed history (the prompt
  // builder skips summary records).
  for (const tc of deliveredCalls.filter((c) => c.summary === true)) {
    expect(internalCalls.some((ic) => ic.tool === tc.tool)).toBe(true);
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
