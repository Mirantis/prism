/**
 * Auto model selection step definitions.
 *
 * The model a turn ran on is read from `llm_calls`, which records every model
 * call with the model id the provider was sent.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

// The runtime's own classification model, and its chat model (`.env.e2e`).
const SMALL_TEST_MODEL = 'global.anthropic.claude-haiku-5-5';
const CHAT_TEST_MODEL =
  process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-5-5';
// Beside a medium tier, the chat model is the medium one and the large tier a
// model no other tier uses, so a medium turn is told apart from a large one.
const LARGE_BESIDE_MEDIUM_TEST_MODEL = 'global.anthropic.claude-opus-5-5';

// The tier each scenario's turn is asserted on. Small and large are the
// two-tier scenario's; medium is the three-tier scenario's.
const TEST_MODELS: Record<string, string> = {
  small: SMALL_TEST_MODEL,
  medium: CHAT_TEST_MODEL,
  large: CHAT_TEST_MODEL,
};

/** The model the newest chat turn's last call went to. */
async function lastTurnModel(): Promise<string | undefined> {
  const row = await dbHelper.getPrisma().llmCall.findFirst({
    where: { agentId: DEFAULT_AGENT_ID, purpose: 'chat' },
    orderBy: { createdAt: 'desc' },
  });
  return row?.model;
}

Given('the agent chooses between the small and the large test models', async ({ page }) => {
  const res = await page.request.patch('/agents/model-selection', {
    data: { mode: 'auto', small: SMALL_TEST_MODEL, large: CHAT_TEST_MODEL },
  });
  expect(res.ok()).toBe(true);
});

Given('the agent chooses between the small, the medium and the large test models', async ({ page }) => {
  const res = await page.request.patch('/agents/model-selection', {
    data: {
      mode: 'auto',
      small: SMALL_TEST_MODEL,
      medium: CHAT_TEST_MODEL,
      large: LARGE_BESIDE_MEDIUM_TEST_MODEL,
    },
  });
  expect(res.ok()).toBe(true);
  // A chat model that is also the small or the large one could not tell the tiers apart.
  expect([SMALL_TEST_MODEL, LARGE_BESIDE_MEDIUM_TEST_MODEL]).not.toContain(CHAT_TEST_MODEL);
});

When('I turn on Auto model selection', async ({ page }) => {
  const auto = page.getByRole('radio', { name: 'Auto' });
  await expect(auto).toBeEnabled();
  await auto.click();
});

When('I enter the small and the large test models', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Small model ID' }).fill(SMALL_TEST_MODEL);
  await page.getByRole('textbox', { name: 'Large model ID' }).fill(CHAT_TEST_MODEL);
});

When('I save the Auto models', async ({ page }) => {
  await page.getByRole('button', { name: 'Save and turn on Auto' }).click();
});

When('I ask {string}', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
  await homePage.typeMessage(text);
  await homePage.sendMessage();
  // 240 s leaves room under the 360 s @slow budget for the Background and the
  // other ask, so a hung turn fails at this step instead of at the test timeout.
  await homePage.waitForStreamComplete(240_000);
});

Then('the profile asks for a small and a large model', async ({ page }) => {
  await expect(page.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('form', { name: 'Auto models' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save and turn on Auto' })).toBeDisabled();
});

Then('the stored model mode is still Fixed', async () => {
  const agent = await dbHelper.getPrisma().agentWorkspace.findUnique({ where: { id: DEFAULT_AGENT_ID } });
  expect(agent?.modelMode).not.toBe('AUTO');
});

Then('the profile shows Auto model selection', async ({ page }) => {
  await expect(page.getByRole('form', { name: 'Auto models' })).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(SMALL_TEST_MODEL, { exact: true })).toBeVisible();
  await expect(page.getByText(CHAT_TEST_MODEL, { exact: true })).toBeVisible();
});

Then('the stored model mode is Auto', async () => {
  await expect.poll(async () => {
    const agent = await dbHelper.getPrisma().agentWorkspace.findUnique({ where: { id: DEFAULT_AGENT_ID } });
    return agent?.modelMode;
  }).toBe('AUTO');
});

Then('the turn ran on the {word} test model', async ({}, tier: string) => {
  // Recording is fire-and-forget, so the row can land just after the reply.
  await expect.poll(lastTurnModel).toBe(TEST_MODELS[tier]);
});

Then("each turn's routing call is recorded", async () => {
  const routing = await dbHelper.getPrisma().llmCall.count({
    where: { agentId: DEFAULT_AGENT_ID, purpose: 'model-routing' },
  });
  expect(routing).toBe(2);
});
