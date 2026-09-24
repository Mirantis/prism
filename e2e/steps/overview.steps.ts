/**
 * Overview Step Definitions — the setup checklist, whose steps tick off from
 * the agent's own state.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { When, Then } = createBdd();

const step = (page: Page, key: string) =>
  page.getByTestId('setup-checklist').locator(`[data-testid="setup-step"][data-step="${key}"]`);

When('I navigate to the overview page', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
});

Then('the {string} setup step is done', async ({ page }, key: string) => {
  await expect(step(page, key)).toHaveAttribute('data-done', 'true');
});

Then('the {string} setup step is not done', async ({ page }, key: string) => {
  await expect(step(page, key)).not.toHaveAttribute('data-done', 'true');
});

Then('the {string} setup step is marked as next', async ({ page }, key: string) => {
  await expect(step(page, key).getByText('Next', { exact: true })).toBeVisible();
});
