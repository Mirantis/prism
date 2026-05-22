/**
 * Agent Status Step Definitions
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { When, Then } = createBdd();

Then('I should see the agent status as {string}', async ({ page }, status: string) => {
  // The StatusBadge renders the status text inside a Badge component in the chat header
  const badge = page.locator('.border-b').getByText(status, { exact: true });
  await expect(badge).toBeVisible({ timeout: 15_000 });
});

When('I reload the page', async ({ page }) => {
  await page.reload({ waitUntil: 'networkidle' });
});
