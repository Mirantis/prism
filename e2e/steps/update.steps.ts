/**
 * Self-update step definitions (disabled-state surfaces).
 *
 * The e2e runtime runs from source, so `/agents/update/status` reports
 * `not_sea_install` and no banner renders. The enabled path (download, swap,
 * restart) is covered by unit tests and the manual smoke on a real packaged
 * install. The `/update` slash-command scenario drives the UI through the
 * shared chat steps ("I type … in the chat input" / "I send the message").
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Then } = createBdd();

const RUNTIME_PORT = 3003;

Then('the update banner is not shown', async ({ page }) => {
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});

Then('the update status reports the updater is off', async () => {
  const res = await fetch(`http://localhost:${RUNTIME_PORT}/agents/update/status`);
  expect(res.ok).toBe(true);
  const status = (await res.json()) as { enabled: boolean; reason: string | null };
  expect(status.enabled).toBe(false);
  expect(status.reason).toBe('not_sea_install');
});
