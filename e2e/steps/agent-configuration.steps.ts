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

/** The Agent tab's editable box — the only document the user writes here. */
function guideBox(page: Page) {
  return page.getByRole('textbox', { name: 'Agent guide' });
}

/** The guide editor's own Save, told apart from the inline model editors'. */
function guideSaveButton(page: Page) {
  return page.locator('[data-slot="tabs-content"]').getByRole('button', { name: 'Save' });
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
  // Scoped to the row: the agent guide editor keeps a Save button of its own,
  // mounted whether or not its tab is showing.
  await input.locator('..').getByRole('button', { name: 'Save' }).click();
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

When('I clear the scheduled-task model override', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit scheduled-task model' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
});

Then('the scheduled-task model override is empty and falls back to the main model', async ({ page }) => {
  await expect(async () => {
    const res = await page.request.get('/agents/cron-model');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as OverrideModelInfo;
    expect(body.model).toBeNull();
    expect(body.effective.length).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Agent guide editor (Profile page → Agent tab)
// ---------------------------------------------------------------------------

Then('the agent guide editor shows the stored guide', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const stored = (await res.json()).agent.agentMd as string;
  // The seed gives the agent a guide, so this also proves the box is populated
  // from the row rather than starting empty.
  expect(stored.length).toBeGreaterThan(0);
  await expect(guideBox(page)).toHaveValue(stored);
});

When('I set the agent guide to {string}', async ({ page }, value: string) => {
  await guideBox(page).fill(value);
});

When('I save the agent guide', async ({ page }) => {
  await guideSaveButton(page).click();
  // The button re-disables once the PATCH lands and the box is clean again,
  // which is what makes the REST read below race-free.
  await expect(guideSaveButton(page)).toBeDisabled();
});

Then('the stored agent guide is {string}', async ({ page }, value: string) => {
  const res = await page.request.get('/agents/details');
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).agent.agentMd).toBe(value);
});

When('I open the {string} tab', async ({ page }, label: string) => {
  await page.getByRole('tab', { name: label, exact: true }).click();
});

Then('that document is read-only', async ({ page }) => {
  const boxes = page.locator('[data-slot="tabs-content"] textarea:visible');
  await expect(boxes).toHaveCount(1);
  await expect(boxes.first()).toHaveJSProperty('readOnly', true);
});
