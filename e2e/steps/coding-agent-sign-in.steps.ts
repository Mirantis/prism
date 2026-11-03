/**
 * Coding agent sign-in step definitions.
 *
 * A finished sign-in needs a real Claude or ChatGPT subscription, so the scenarios
 * start one and check what the person gets to finish it with: the provider's page,
 * and the code field or the code to enter there.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

/** How long the runtime may take to start the coding agent's sign-in and print its link. */
const SIGN_IN_TIMEOUT = 60_000;

interface CodingAgentRow {
  agent: string;
  name: string;
  available: boolean;
  account: { plan: string; email: string } | null;
  attempt: { id: string } | null;
}

/** The sign-in page the first dialog of the scenario opened. */
let signInUrl: string | null = null;

async function codingAgent(page: Page, name: string): Promise<CodingAgentRow> {
  const response = await page.request.get('/agents/coding-agents');
  expect(response.ok()).toBe(true);
  const { agents } = await response.json() as { agents: CodingAgentRow[] };
  const row = agents.find(item => item.name === name);
  expect(row, `GET /agents/coding-agents lists ${name}`).toBeDefined();
  return row!;
}

function signInDialog(page: Page, provider: string) {
  return page.getByRole('dialog', { name: `Sign in to ${provider}` });
}

Given('{string} is not signed in to a subscription', async ({ page }, name: string) => {
  signInUrl = null;
  const row = await codingAgent(page, name);
  test.skip(!row.available, `${name} is not installed where this runtime runs its commands.`);
  test.skip(row.account !== null, `${name} holds a saved subscription login, which this scenario keeps.`);
});

When('I start signing {string} in', async ({ page }, name: string) => {
  const row = page.getByRole('listitem', { name });
  await expect(row).toContainText(/Uses the deployment's models|Signed out\. Its work fails until you sign in again\./);
  await row.getByRole('button', { name: 'Sign in' }).click();
});

When('I close the sign-in', async ({ page }) => {
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

When('I open the link the agent sends for the {string} sign-in', async ({ page }, name: string) => {
  const row = await codingAgent(page, name);
  expect(row.attempt, `${name} has an open sign-in`).not.toBeNull();
  await page.goto(`/coding-agents?${new URLSearchParams({ agent: row.agent }).toString()}`);
  await expect(page).toHaveURL(/\/profile\?/);
});

async function expectClaudeCodeStep(page: Page): Promise<string> {
  const dialog = signInDialog(page, 'Claude');
  await expect(dialog).toContainText("Open Claude's sign-in page.", { timeout: SIGN_IN_TIMEOUT });
  await expect(dialog).toContainText('Paste the code it shows.');
  const link = dialog.getByRole('link', { name: 'Open sign-in' });
  await expect(link).toHaveAttribute('href', /^https:\/\//);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(dialog.getByLabel('Code')).toBeEditable();
  await expect(dialog.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  return (await link.getAttribute('href'))!;
}

Then('the Claude sign-in asks for the code from its sign-in page', async ({ page }) => {
  signInUrl = await expectClaudeCodeStep(page);
});

Then('the Claude sign-in asks for the code from the same sign-in page', async ({ page }) => {
  expect(await expectClaudeCodeStep(page)).toBe(signInUrl);
});

Then('the ChatGPT sign-in shows a code to enter on its sign-in page', async ({ page }) => {
  const dialog = signInDialog(page, 'ChatGPT');
  await expect(dialog).toContainText("Open ChatGPT's sign-in page.", { timeout: SIGN_IN_TIMEOUT });
  await expect(dialog).toContainText('Enter this code:');
  await expect(dialog.getByTestId('coding-agent-user-code')).toHaveText(/\S/);
  await expect(dialog.getByRole('link', { name: 'Open sign-in' })).toHaveAttribute('href', /^https:\/\//);
  await expect(dialog).toContainText("Waiting for you to finish on OpenAI's page…");
});
