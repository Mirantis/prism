/**
 * Skills slash-command step definitions (web).
 *
 * The `/skills` listing and the command-popup steps are deterministic (no LLM).
 * `/skills run echo-marker` goes through the real conversation engine: the
 * seeded SKILL.md (see playwright.config.ts → PRISM_DATA_DIR) tells the agent to
 * reply with a fixed sentinel, asserted in the conversation. Typing uses
 * shared steps from chat.steps.ts ("I type … in the chat input", "I send the
 * message", "I should see the message …").
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';

const { When, Then } = createBdd();

When('I press Tab in the chat input', async ({ page }) => {
  const home = new HomePage(page);
  await home.pressKeyInInput('Tab');
});

Then('I should see the command popup', async ({ page }) => {
  const home = new HomePage(page);
  await expect(home.commandPopup).toBeVisible({ timeout: 5_000 });
});

Then('the command popup should list {string}', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await expect(home.commandPopupItem(name)).toBeVisible();
});

Then('the chat input should contain {string}', async ({ page }, expected: string) => {
  const home = new HomePage(page);
  await expect.poll(() => home.inputValue()).toContain(expected);
});
