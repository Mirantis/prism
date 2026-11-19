/**
 * ChatGPT subscription (`LLM_PROVIDER=chatgpt`) web e2e step definitions.
 *
 * Interactive browser sign-in requires a real ChatGPT account, so the active
 * provider scenario verifies the real Profile card and the OAuth 2.0 + PKCE
 * authorization URL returned by `POST /agents/chatgpt-auth/start`.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

interface ChatGptAuthStatus {
  enabled: boolean;
  signedIn: boolean;
  email: string | null;
  expiresAt: number | null;
}

async function fetchStatus(page: Page): Promise<ChatGptAuthStatus> {
  const response = await page.request.get('/agents/chatgpt-auth/status');
  expect(response.ok()).toBe(true);
  return (await response.json()) as ChatGptAuthStatus;
}

Given('the runtime is not configured for the ChatGPT subscription provider', async ({ page }) => {
  const status = await fetchStatus(page);
  test.skip(status.enabled, 'Runtime is configured with LLM_PROVIDER=chatgpt.');
});

Given(
  'the runtime is configured for the ChatGPT subscription provider and not signed in',
  async ({ page }) => {
    const status = await fetchStatus(page);
    test.skip(!status.enabled, 'Runtime is not configured with LLM_PROVIDER=chatgpt.');
    test.skip(status.signedIn, 'Runtime already holds a ChatGPT sign-in.');
  },
);

Then('the ChatGPT subscription card is not shown', async ({ page }) => {
  await expect(page.getByText('ChatGPT subscription')).toHaveCount(0);
});

When('I click Sign in with ChatGPT', async ({ page }) => {
  await expect(page.getByText('ChatGPT subscription')).toBeVisible();
  await expect(page.getByText('Not signed in')).toBeVisible();
  // Prevent the browser from opening an external popup tab during the test.
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
});

Then(
  'the ChatGPT subscription card waits for browser sign-in with an OpenAI authorization link',
  async ({ page }) => {
    await expect(page.getByText('Waiting for browser sign-in')).toBeVisible();
    const link = page.getByRole('link', { name: 'open the ChatGPT sign-in page' });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
  },
);
