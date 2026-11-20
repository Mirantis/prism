/**
 * No LLM provider step definitions — the warning on the Overview, and the
 * absence of it when a provider is configured.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';

const { Given, When, Then } = createBdd();

/**
 * Gated here like @single-thread: the runtime reads its credentials at boot, so
 * this feature is its own invocation —
 *   npm run test:e2e:no-llm-provider --workspace=prism-agent-e2e
 */
Given('the runtime was started with no LLM credential', async () => {
  test.skip(process.env.E2E_NO_LLM_PROVIDER !== 'true', 'Needs a runtime started with no LLM credential.');
});

Then(
  'the overview warns that no LLM provider is configured, naming {string}',
  async ({ page }, setting: string) => {
    const banner = page.getByTestId('llm-provider-banner');
    await expect(banner.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Provider setup guide' })).toHaveAttribute(
      'href', 'https://github.com/Mirantis/prism/blob/main/docs/configuration.md#provider-selection',
    );
    await expect(banner).toContainText(setting);
  },
);

Then('the overview shows no LLM provider warning', async ({ page }) => {
  await expect(page.getByTestId('setup-checklist')).toBeVisible();
  await expect(page.getByTestId('llm-provider-banner')).toHaveCount(0);
});

When('I copy the provider setting {string}', async ({ page }, setting: string) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: `Copy ${setting}`, exact: true }).click();
});
