/**
 * Chat Step Definitions
 */

import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID, E2E_WORKSPACE } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

/**
 * File the steering scenario has the agent touch as the first thing its shell
 * command does. The shell tool runs commands with the workspace as cwd, so the
 * relative path in the prompt resolves here.
 */
const STEERING_MARKER = path.join(E2E_WORKSPACE, 'steering-started.marker');

/** Poll `fn` until `ok` holds or the timeout elapses; returns the last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!ok(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

/**
 * Messages the agent under test actually delivered. Intermediate steps are also
 * persisted as AGENT rows (`internalStep`) but were never sent to the user, so
 * they are excluded — a step in which the model narrates its plan is not a
 * reply. The Before hook in common.steps.ts resets the database per scenario,
 * so an agent-wide query is unambiguous.
 */
function deliveredMessages(role: 'USER' | 'AGENT') {
  return dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role, internalStep: false },
  });
}

When('I type {string} in the chat input', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await homePage.typeMessage(text);
});

When('I send the message', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.sendMessage();
});

When('I stop the in-progress response', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.stopResponse();
});

Given('the shell workspace has no steering marker', async () => {
  // The workspace outlives a scenario (only the database is reset per run), so
  // a marker left by an earlier run would let the next one send too early.
  fs.rmSync(STEERING_MARKER, { force: true });
});

When('the agent has started running the shell command', async () => {
  // Waiting on the STOP button is not enough to be mid-turn: the composer flips
  // to "responding" optimistically the moment the first message is sent, before
  // the runtime has done anything. A message sent then reaches the turn's very
  // first step, where the model has not yet committed to the original
  // instruction — it reads as one combined request rather than a redirect. The
  // marker is written by the agent's own shell command, so its appearance means
  // the tool is executing right now and the next step boundary is the real
  // change-of-course moment.
  const found = await pollUntil(
    async () => fs.existsSync(STEERING_MARKER),
    (ok) => ok,
    60_000,
    500,
  );
  expect(found).toBe(true);
});

When('I send the message while the agent is responding', async ({ page }) => {
  const homePage = new HomePage(page);
  // Waiting for STOP is what makes this a mid-turn send: the button only
  // renders while a turn is in flight. Send is live alongside it, so the click
  // hands the typed message to the turn that already owns the thread.
  await homePage.waitForResponding();
  await homePage.sendMessage();
});

Then('the chat composer should be ready for input again', async ({ page }) => {
  const homePage = new HomePage(page);
  // Send is always present now, so its visibility proves nothing. What marks
  // the end of the turn is the typing indicator clearing (runtime broadcast
  // processing:false) and STOP going away with it.
  await homePage.waitForStreamComplete();
  await expect(homePage.stopButton).toBeHidden();
});

Then('the agent reply contains {string}', async ({}, sentinel: string) => {
  // Asserted against a stored AGENT row rather than the screen: the composer
  // stays live during a turn, so the sentinel is on screen the moment it is
  // typed and a DOM matcher would pass against the user's own draft.
  const replies = await pollUntil(
    () => deliveredMessages('AGENT'),
    (rows) => rows.some((r) => r.content.includes(sentinel)),
    80_000,
  );
  expect(replies.map((r) => r.content).join('\n')).toContain(sentinel);
});

Then('no reply is an error', async ({ page }) => {
  // Its own step rather than a rider on the sentinel assertion: an LLM/runtime
  // failure surfaces as a bubble starting "I encountered an error…" (see
  // lib/llm-errors.ts#buildErrorStep), and a failure of *that* must not read as
  // "the sentinel is missing".
  //
  // Waits for the turn first, for the same reason the ALPHA assertion does: this
  // one also passes by finding nothing, so a mid-stream read would miss an error
  // delivered a moment later. Standing on its own is what made that visible —
  // riding along behind the sentinel poll had hidden it.
  await new HomePage(page).waitForStreamComplete();
  const replies = await deliveredMessages('AGENT');
  expect(replies.map((r) => r.content).join('\n')).not.toMatch(/I encountered an error/i);
});

Then('the thread has {int} user message(s)', async ({}, expected: number) => {
  // Both messages became history, and the mid-turn one was stored exactly once.
  const rows = await pollUntil(
    () => deliveredMessages('USER'),
    (r) => r.length >= expected,
    30_000,
  );
  expect(rows).toHaveLength(expected);
});

Then('no delivered agent message contains {string}', async ({ page }, forbidden: string) => {
  // The steer-vs-queue discriminator. Had the second message queued behind the
  // thread lock instead of being handed to the running turn, the first turn
  // would have run to completion and answered with this sentinel before the
  // second turn ever started.
  //
  // Delivered rows only, deliberately: the model announces its original plan in
  // the step that issues the shell call, which is written before the redirect
  // reaches it. That intermediate step legitimately names the sentinel and is
  // never shown to the user — what proves the turn changed course is that no
  // *reply* carries it.
  //
  // This depends on the agent running with `verbose = false`, which the seed
  // takes from the schema default (AgentWorkspace.verbose) rather than setting.
  // Under verbose every step is delivered with `internalStep: false`, including
  // that narration, and this assertion would fail on correct behavior. If the
  // seed ever turns verbose on, this is the line that has to change.
  //
  // Read once, after the turn ends. This is the one assertion here that passes
  // by finding nothing, so it has to be made against the finished conversation:
  // sampled mid-stream it would also pass on a turn that goes on to deliver the
  // sentinel a moment later.
  await new HomePage(page).waitForStreamComplete();
  const rows = await deliveredMessages('AGENT');
  expect(rows.filter((r) => r.content.includes(forbidden))).toHaveLength(0);
});

Then('I should see my message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});

Then('I should see an agent response in the conversation', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages.first()).toBeVisible();

  // Wait for streaming to finish before reading text, otherwise we'd race the
  // partial frames. Agent-runtime surfaces LLM failures as a bubble starting
  // with "I encountered an error…" (see lib/llm-errors.ts#buildErrorStep), so
  // anchor the rejection to that prefix rather than a bare substring.
  await homePage.waitForStreamComplete();
  await expect(agentMessages.last()).not.toHaveText(/^\s*I encountered an error/i);
});

Then('I should see the message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});
