/**
 * Command-popup step definitions (web): the popup the composer opens on "/",
 * and Tab completion of the highlighted entry. Deterministic — no LLM call.
 *
 * What each command then does is asserted in that command's own feature, using
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
