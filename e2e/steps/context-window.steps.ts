/**
 * Remaining context-window indicator step definitions.
 *
 * The assertions that matter here compare the *rendered* percentage against the
 * snapshot the runtime persisted, recomputing the expected integer in the step.
 * That exercises the whole chain — provider usage → per-turn snapshot → thread
 * column → derived percentage → DOM — rather than just checking that some
 * percent-looking text exists.
 *
 * Note: the "I reload the chat page" step is defined once in
 * file-sharing.steps.ts; playwright-bdd hard-errors on a duplicate definition.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';
// The same vendored catalog the runtime resolves windows from. Read here rather
// than hardcoding a number: the e2e agent's model is whatever the environment
// configures, so a literal would silently encode the wrong denominator.
import modelLimits from '../../backend/src/lib/model_limits.generated.json';

const { Given, When, Then } = createBdd();

/** Look up a Bedrock model's input-context window, failing loudly if absent. */
function windowFor(modelId: string): number {
  const limits = (modelLimits as Record<string, Record<string, { context: number } | undefined>>)
    .bedrock?.[modelId];
  if (!limits) {
    throw new Error(
      `model "${modelId}" is not in the bundled catalog, so the indicator would be hidden entirely. ` +
        'Regenerate with `npm run generate:model-limits`.',
    );
  }
  return limits.context;
}

const contextMeter = (page: Page) => page.getByTestId('context-meter');

async function latestThread() {
  const prisma = dbHelper.getPrisma();
  const thread = await prisma.conversationThread.findFirst({
    where: { agentId: DEFAULT_AGENT_ID },
    orderBy: { updatedAt: 'desc' },
  });
  if (!thread) throw new Error('no thread found for the default agent');
  return thread;
}

Given('I open a fresh chat', async ({ page }) => {
  await new HomePage(page).navigate();
});

Given('the thread has a stored snapshot for an unrecognized model', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
  await homePage.typeMessage('Say ready and nothing else.');
  await homePage.sendMessage();
  await homePage.waitForStreamComplete();

  // Write the columns directly rather than pointing the agent at a fake model:
  // an unknown model ID would fail against real Bedrock, and this path is about
  // the read → derive → render side, which stays deterministic.
  const thread = await latestThread();
  await dbHelper.getPrisma().conversationThread.update({
    where: { id: thread.id },
    data: { contextTokens: 250_000, contextModel: 'some-retired-deployment' },
  });
});

When('a chat turn completes', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
  await homePage.typeMessage('Reply with exactly: context-window-e2e-ok');
  await homePage.sendMessage();
  await homePage.waitForStreamComplete();
});

Then('the context indicator shows a usage percentage', async ({ page }) => {
  await expect(contextMeter(page)).toHaveText(/\d+% context used/, { timeout: 30_000 });
});

Then('the chat shows no context indicator', async ({ page }) => {
  // Nothing measured means no reading at all — never a reassuring "100%", which
  // would be a claim the runtime hasn't earned (the system prompt alone is
  // thousands of tokens).
  await expect(contextMeter(page)).toHaveCount(0);
});

Then("the thread's stored context snapshot is populated", async () => {
  const thread = await latestThread();

  // A real measurement, not a default: the prompt includes the system prompt and
  // tool definitions, so it is comfortably above zero.
  expect(thread.contextTokens).toBeGreaterThan(0);
  expect(thread.contextModel).toBeTruthy();
});

Then('the indicator percentage matches the stored snapshot', async ({ page }) => {
  const thread = await latestThread();
  const usedTokens = thread.contextTokens!;
  const windowTokens = windowFor(thread.contextModel!);

  // Recompute independently rather than trusting the server's number: this is
  // what catches a denominator regression (e.g. reserving the output budget, or
  // adding cache tokens on top of an already-inclusive inputTokens).
  const expectedPercent = Math.min(100, Math.max(0, Math.round((100 * usedTokens) / windowTokens)));

  await expect(contextMeter(page)).toHaveText(`${expectedPercent}% context used`, {
    timeout: 30_000,
  });

  // The tooltip is the only place the raw counts surface. Compare digits only —
  // the component formats with the browser's locale, whose thousands separator
  // isn't ours to assume.
  const title = (await contextMeter(page).getAttribute('title')) ?? '';
  const numbers = title.match(/[\d][\d.,\u00A0\u202F ]*/g)?.map((n) => n.replace(/\D/g, '')) ?? [];
  expect(numbers.slice(0, 2)).toEqual([String(usedTokens), String(windowTokens)]);
  expect(title).toContain(thread.contextModel!);
});
