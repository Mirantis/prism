/**
 * Agent Configuration Step Definitions
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Then } = createBdd();

Then('I should see the agent stat cards', async ({ page }) => {
  await expect(page.getByText('Proactivity')).toBeVisible();
  await expect(page.getByText('Heartbeat', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Last Heartbeat')).toBeVisible();
  await expect(page.getByText('Created')).toBeVisible();
});

Then('I should see the agent type badge', async ({ page }) => {
  // The agent type is rendered as a Badge near the agent name
  await expect(page.getByText('Agent', { exact: true }).first()).toBeVisible();
});

Then('I should see the heartbeat status', async ({ page }) => {
  // The Heartbeat stat card shows the heartbeat status and "Every ..." interval
  await expect(page.getByText(/^Every /)).toBeVisible();
});

Then('I should see the heartbeat interval {string}', async ({ page }, expected: string) => {
  // The Heartbeat stat card shows "Every Xh" below the status
  await expect(page.getByText(expected, { exact: true })).toBeVisible();
});

Then('I should see profile tabs for {string}, {string}, {string}, {string}, {string}', async (
  { page },
  s1: string, s2: string, s3: string, s4: string, s5: string,
) => {
  // Profile tabs are TabsTrigger elements inside the Profiles card
  for (const label of [s1, s2, s3, s4, s5]) {
    await expect(page.getByRole('tab', { name: label })).toBeVisible();
  }
});
