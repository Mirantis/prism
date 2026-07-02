/**
 * Concise-vs-verbose delivery step definitions.
 *
 * Concise (verbose=false, the default) publishes only the final result of a
 * multi-step turn — asserted as exactly one agent bubble that still carries
 * the folded tool-call trail. The Verbosity selector's persistence is asserted
 * against the authoritative runtime state (`GET /agents/details`), not just the
 * UI. Verbose per-step streaming is covered by the engine unit tests, since the
 * delivered-message count under a real model is nondeterministic.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';

const { When, Then } = createBdd();

/**
 * Forces a genuinely multi-step, tool-using turn. Concise mode must collapse it
 * to a single message that still carries the folded tool-call trail.
 */
const TWO_STEP_PROMPT =
  'Use the shell_exec tool, one command per step. First run `echo prism-vrb-1`. ' +
  'After you see its output, reply with a sentence telling me exactly what it ' +
  'printed, and then run `echo prism-vrb-2`. After that output, give a ' +
  'one-sentence final summary.';

When('I send a prompt that forces two tool steps with narration', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.typeMessage(TWO_STEP_PROMPT);
  await homePage.sendMessage();
});

When('I turn verbose responses on', async ({ page }) => {
  // Open the Verbosity dropdown and pick "Verbose".
  await page.getByRole('button', { name: /^(Concise|Verbose)/ }).click();
  await page.getByRole('menuitemradio', { name: 'Verbose' }).click();
});

Then('the response completes with exactly 1 agent message', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();
  await expect(homePage.getAgentMessages()).toHaveCount(1);
  await expect(homePage.getAgentMessages().last()).not.toHaveText(/^\s*I encountered an error/i);
});

Then('the agent message shows a tool-call trail', async ({ page }) => {
  // ChatToolCalls renders "N tool(s) used" on the message carrying toolCalls;
  // in concise mode the folded trail must land on the single final message.
  await expect(page.getByText(/\d+ tools? used/)).toBeVisible();
});

Then('the stored verbose setting is true', async ({ page }) => {
  await expect(async () => {
    const res = await page.request.get('/agents/details');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { agent: { verbose: boolean } };
    expect(body.agent.verbose).toBe(true);
  }).toPass({ timeout: 5000 });
});
