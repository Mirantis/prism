/**
 * Generated UI step definitions.
 *
 * One scenario has the agent call the tool. The other seeds a UI on an agent
 * message, so it makes no model call to get one.
 *
 * Another person is a request with the headers the Mirantis Agent Platform ingress
 * writes, as in the question card steps.
 */

import { randomUUID } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

const UI_TIMEOUT = 120_000;

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
let seeded: { threadId: string; uiId: string } | undefined;

function seededUi() {
  return {
    type: 'generated_ui',
    version: 1,
    id: randomUUID(),
    root: 'week',
    elements: {
      week: { type: 'Card', props: { title: 'Deploys this week' }, children: ['state', 'per-day', 'steps', 'choose'] },
      state: { type: 'Table', props: { columns: ['Service', 'State'], rows: [['api', 'green'], ['web', 'red']] } },
      'per-day': {
        type: 'Chart',
        props: { kind: 'bar', title: 'Deploys per day', categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'prod', values: [3, 5, 2] }] },
      },
      steps: { type: 'Checklist', props: { items: [{ text: 'Tag the release', done: true }, { text: 'Tell support', done: false }] } },
      choose: { type: 'Actions', children: ['roll-back', 'keep', 'runbook'] },
      'roll-back': { type: 'Button', props: { label: 'Roll back', style: 'danger' } },
      keep: { type: 'Button', props: { label: 'Keep it' } },
      runbook: { type: 'LinkButton', props: { label: 'Runbook', url: 'https://example.com/runbook' } },
    },
  };
}

function ui(page: Page) {
  return page.getByTestId('generated-ui').last();
}

function pressUrl(): string {
  if (!seeded) throw new Error('No generated UI was seeded');
  return `/agents/generated-ui/${seeded.uiId}/press`;
}

Given('a conversation with a generated UI', async ({ page }) => {
  const threadId = await dbHelper.createThread(getCurrentAgentId(), { title: 'Generated UI' });
  const block = seededUi();
  const response = await page.request.post(`/agents/threads/${threadId}/messages`, {
    data: { content: 'The UI as text.', role: 'AGENT', triggeredBy: 'USER_INPUT', blocks: [block] },
  });
  expect(response.status()).toBe(201);
  seeded = { threadId, uiId: block.id };
});

When('I open the conversation with the UI', async ({ page }) => {
  if (!seeded) throw new Error('No generated UI was seeded');
  const home = new HomePage(page);
  await home.goto(`/chat/${seeded.threadId}`);
  await page.waitForLoadState('networkidle');
});

Then('the UI shows the heading {string}', async ({ page }, title: string) => {
  await expect(ui(page).getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: UI_TIMEOUT });
});

Then('the UI shows a table with the cell {string}', async ({ page }, text: string) => {
  await expect(ui(page).getByRole('cell', { name: text, exact: true }).first()).toBeVisible({ timeout: UI_TIMEOUT });
});

Then('the UI shows the chart {string}', async ({ page }, title: string) => {
  await expect(ui(page).getByText(title, { exact: true }).first()).toBeVisible();
});

Then('the UI shows the checklist item {string}', async ({ page }, text: string) => {
  await expect(ui(page).getByRole('listitem').filter({ hasText: text })).toBeVisible();
});

Then('the press shows as my message {string}', async ({ page }, label: string) => {
  const mine = page.locator('[data-message-role="user"]').getByText(label, { exact: true });
  await expect(mine).toHaveCount(1, { timeout: 30_000 });
});

Then('the press shows as a message from {string}: {string}', async ({ page }, name: string, label: string) => {
  const theirs = page.locator('[data-message-role="participant"]').filter({ hasText: name });
  await expect(theirs.getByText(label, { exact: true })).toHaveCount(1, { timeout: 30_000 });
});

Then('the UI shows a link {string} to {string}', async ({ page }, label: string, url: string) => {
  await expect(ui(page).getByRole('link', { name: label })).toHaveAttribute('href', url);
});

When('I press {string} in the UI', async ({ page }, label: string) => {
  await ui(page).getByRole('button', { name: label }).click();
});

Then('the UI shows {string} under {string}', async ({ page }, line: string, label: string) => {
  const button = ui(page).getByRole('button', { name: label });
  await expect(button).toHaveAccessibleDescription(line, { timeout: 30_000 });
  await expect(ui(page).getByRole('button').filter({ hasNotText: 'Runbook' }).first()).toBeDisabled();
});

When('{string} presses {string} in the UI first', async ({ page }, name: string, label: string) => {
  const elementId = label === 'Roll back' ? 'roll-back' : 'keep';
  const response = await page.request.post(pressUrl(), {
    headers: {
      'x-forwarded-user-id': randomUUID(),
      'x-forwarded-user-display-name': encodeURIComponent(name),
    },
    data: { elementId },
  });
  expect(response.status()).toBe(200);
});

Then('another press in the UI is refused with the stored UI', async ({ page }) => {
  const response = await page.request.post(pressUrl(), { data: { elementId: 'keep' } });
  expect(response.status()).toBe(409);
  const { ui: stored } = (await response.json()) as { ui: { pressed: { elementId: string } } };
  expect(stored.pressed.elementId).toBe('roll-back');
});
