/**
 * No LLM provider step definitions — the warning on the Overview, and the
 * absence of it when a provider is configured.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';

const { Given, Then } = createBdd();

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
    await expect(banner).toContainText('No LLM provider is configured');
    await expect(banner).toContainText(setting);
  },
);

Then('the overview shows no LLM provider warning', async ({ page }) => {
  await expect(page.getByTestId('setup-checklist')).toBeVisible();
  await expect(page.getByTestId('llm-provider-banner')).toHaveCount(0);
});
