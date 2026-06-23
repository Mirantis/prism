/**
 * Agent Configuration Step Definitions
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const { When, Then } = createBdd();

interface OverrideModelInfo {
  model: string | null;
  effective: string;
}

/**
 * Edit one of the inline model fields on the Profile page: click its pencil,
 * type the value, Save, and wait for the editor to close on the new value.
 * `label` matches the field's visible label / aria-labels (e.g.
 * "Heartbeat model", "Scheduled-task model").
 */
async function setModelField(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('button', { name: `Edit ${label.toLowerCase()}` }).click();
  const input = page.getByRole('textbox', { name: `${label} ID` });
  await input.fill(value);
  await page.getByRole('button', { name: 'Save' }).click();
  // Editor closes and shows the saved value; waiting here avoids racing the
  // REST read against the in-flight PATCH.
  await expect(page.getByText(value, { exact: true })).toBeVisible();
}

Then('I should see the agent stat cards', async ({ page }) => {
  // Profile page exposes identity + heartbeat status cards. Use exact:true
  // because the page intro paragraph ("Agent identity, heartbeat status,
  // and workspace markdown files.") substring-matches several of these.
  await expect(page.getByText('Identity', { exact: true })).toBeVisible();
  await expect(page.getByText('Heartbeat Status', { exact: true })).toBeVisible();
  await expect(page.getByText('Last heartbeat', { exact: true })).toBeVisible();
});

Then('I should see the agent type badge', async ({ page }) => {
  // The "Agent" tab label is the closest analog to the old agent-type badge.
  await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();
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

When('I set the heartbeat model to {string}', async ({ page }, value: string) => {
  await setModelField(page, 'Heartbeat model', value);
});

When('I set the scheduled-task model to {string}', async ({ page }, value: string) => {
  await setModelField(page, 'Scheduled-task model', value);
});

Then('the stored heartbeat model override is {string}', async ({ page }, value: string) => {
  // Verify the authoritative runtime state (proxied via the Vite dev server).
  const res = await page.request.get('/agents/heartbeat-model');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as OverrideModelInfo;
  expect(body.model).toBe(value);
});

Then('the stored scheduled-task model override is {string}', async ({ page }, value: string) => {
  const res = await page.request.get('/agents/cron-model');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as OverrideModelInfo;
  expect(body.model).toBe(value);
});

When('I clear the heartbeat model override', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit heartbeat model' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
});

Then('the heartbeat model override is empty and falls back to the main model', async ({ page }) => {
  await expect(async () => {
    const res = await page.request.get('/agents/heartbeat-model');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as OverrideModelInfo;
    expect(body.model).toBeNull();
    expect(body.effective.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});
