import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { getPrisma } from '../support/db-helper';

const { Given, When, Then } = createBdd();
const TASK_NAME = 'Workspace review';
const INSTRUCTION = 'Summarize project progress and list the next steps.';

Given('the workspace has a design conversation and a release conversation', async ({ request }) => {
  const response = await request.get('/agents/me');
  expect(response.ok()).toBe(true);
  const { agentId, userId } = await response.json();
  for (const title of ['Design review', 'Release checklist']) {
    await getPrisma().conversationThread.create({
      data: {
        agentId,
        userId,
        title,
        messages: {
          create: { role: 'USER', content: `Notes for ${title}`, triggeredBy: 'USER_INPUT' },
        },
      },
    });
  }
});

When('I resume the design conversation from the overview', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('region', { name: 'Recent conversations' })
    .getByRole('link', { name: /Design review/ })
    .click();
});

Then('the design conversation and its history are visible', async ({ page }) => {
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  await expect(
    page.getByTestId('chat-messages').getByText('Notes for Design review'),
  ).toBeVisible();
  await expect(
    page.getByTestId('recent-thread').filter({ hasText: 'Design review' }),
  ).toHaveAttribute('data-active', 'true');
});

When('I search recent conversations for {string}', async ({ page }, term: string) => {
  if (!page.url().includes('/chat')) await page.goto('/chat');
  await page.getByLabel('Search recent conversations').fill(term);
});
Then('only the design conversation appears in Recents', async ({ page }) => {
  await expect(page.getByTestId('recent-thread')).toHaveCount(1);
  await expect(page.getByTestId('recent-thread')).toHaveText('Design review');
});
Then('I see an empty conversation search result', async ({ page }) => {
  await expect(page.getByText('No matching conversations')).toBeVisible();
  await expect(page.getByTestId('recent-thread')).toHaveCount(0);
});
When('I clear the conversation search', async ({ page }) => {
  await page.getByRole('button', { name: 'Clear conversation search' }).click();
  await expect(page.getByLabel('Search recent conversations')).toBeFocused();
});
Then('both workspace conversations appear in Recents', async ({ page }) => {
  await expect(
    page.getByTestId('recent-thread').filter({ hasText: 'Design review' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('recent-thread').filter({ hasText: 'Release checklist' }),
  ).toBeVisible();
});
When('I start a new conversation from the phone menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await page
    .getByRole('dialog', { name: 'Sidebar' })
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
});
Then('the phone menu closes and the empty chat composer is visible', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'What shall we work on?' })).toBeVisible();
  await expect(page.getByPlaceholder('Message your agent...')).toBeInViewport();
});

When(
  'I create a workspace task with the {string} preset at {string} size',
  async ({ page }, preset: string, size: string) => {
    await page.setViewportSize(
      size === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.goto('/cron');
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(TASK_NAME);
    await page.getByRole('button', { name: preset, exact: true }).click();
    await expect(page.getByRole('button', { name: preset, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByLabel('Instruction', { exact: true }).fill(INSTRUCTION);
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  },
);
Then(
  'the task card shows {string} and {string}',
  async ({ page }, description: string, expression: string) => {
    const card = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: TASK_NAME }) });
    await expect(card.getByText(INSTRUCTION)).toBeVisible();
    await expect(card.getByText(description, { exact: true })).toBeVisible();
    await expect(card.getByText(expression, { exact: true })).toBeVisible();
    await expect(card.getByText('Active', { exact: true })).toBeVisible();
  },
);
When('I reload the schedule page', async ({ page }) => {
  await page.reload();
});
When('I delete the workspace task', async ({ page }) => {
  await page.getByRole('button', { name: `Delete ${TASK_NAME}`, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
});
Then('the workspace task is removed', async ({ page }) => {
  await expect(page.getByRole('heading', { name: TASK_NAME, exact: true })).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: TASK_NAME, exact: true })).not.toBeVisible();
});
When('I submit an invalid workspace schedule', async ({ page }) => {
  await page.goto('/cron');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(TASK_NAME);
  await page.getByLabel('Schedule', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
});
Then('the schedule form remains open with an error', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'New scheduled task' })).toBeVisible();
  await expect(
    page.getByRole('dialog').getByText('Invalid cron expression: invalid', { exact: true }),
  ).toBeVisible();
});
When('I correct the workspace schedule to {string}', async ({ page }, expression: string) => {
  await page.getByLabel('Schedule', { exact: true }).fill(expression);
  await expect(page.getByRole('button', { name: 'Daily', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
Then('the custom workspace schedule is saved', async ({ page }) => {
  await page.reload();
  await expect(page.getByText('30 14 * * 2', { exact: true })).toBeVisible();
});
