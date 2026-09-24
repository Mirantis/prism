import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';
import { TEST_USER } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

const DAY_MS = 24 * 60 * 60 * 1000;

Given('a conversation thread rooted at {string}', async ({}, workspaceRoot: string) => {
  await dbHelper.createThread(getCurrentAgentId(), { workspaceRoot });
});

Given(
  'a conversation thread titled {string} rooted at {string}',
  async ({}, title: string, workspaceRoot: string) => {
    await dbHelper.createThread(getCurrentAgentId(), { title, workspaceRoot });
  },
);

Given('an older conversation thread rooted at {string}', async ({}, workspaceRoot: string) => {
  // Backdated so a thread created afterward sorts above it (createdAt desc).
  await dbHelper.createThread(getCurrentAgentId(), {
    workspaceRoot,
    createdAt: new Date(Date.now() - DAY_MS),
  });
});

Given(
  'an older conversation thread rooted at {string} containing {string}',
  async ({}, workspaceRoot: string, content: string) => {
    await dbHelper.createThread(getCurrentAgentId(), {
      workspaceRoot,
      createdAt: new Date(Date.now() - DAY_MS),
      messages: [{ role: 'USER', content }],
    });
  },
);

Given('a conversation thread with no workspace root', async () => {
  await dbHelper.createThread(getCurrentAgentId());
});

Given('a Slack conversation thread', async () => {
  await dbHelper.createThread(getCurrentAgentId(), {
    threadSource: 'SLACK',
    externalThreadId: `mock-slack-ts-${Date.now()}`,
    externalChannelId: 'C_MOCK_E2E',
  });
});

Then('the Recents list shows {string} above {string}', async ({ page }, first: string, second: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreads.filter({ hasText: first })).toBeVisible();
  await expect(home.recentThreads.filter({ hasText: second })).toBeVisible();
  const names = await home.recentThreadNames();
  const firstIdx = names.indexOf(first);
  const secondIdx = names.indexOf(second);
  expect(firstIdx).toBeGreaterThanOrEqual(0);
  expect(secondIdx).toBeGreaterThan(firstIdx);
});

Then('the Recents list shows {string}', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreads.filter({ hasText: name })).toBeVisible();
});

When('I click the {string} conversation in Recents', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await home.recentThreads.filter({ hasText: name }).click();
});

Then('the URL is a chat thread URL', async ({ page }) => {
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
});

Then('the Recents list does not show {string}', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreads.filter({ hasText: name })).toHaveCount(0);
});

Then('the {string} conversation is highlighted as current', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreads.filter({ hasText: name })).toHaveAttribute('data-active', 'true');
});

Then('the {string} conversation is not highlighted', async ({ page }, name: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreads.filter({ hasText: name })).not.toHaveAttribute('data-active', 'true');
});

Then('the Recents list has {int} conversation(s)', async ({ page }, count: number) => {
  const home = new HomePage(page);
  await expect(home.recentThreads).toHaveCount(count);
});

When('I click the new conversation button', async ({ page }) => {
  await new HomePage(page).newThreadButton.click();
});

// Authoritative check against the management API rather than the rendered
// sidebar — counts the thread rows the runtime actually stored.
Then('the agent has {int} stored conversation thread(s)', async ({ page }, count: number) => {
  const res = await page.request.get(
    `/agents/threads?userId=${TEST_USER.id}&agentId=${getCurrentAgentId()}&threadSource=DATABASE`,
  );
  expect(res.ok()).toBe(true);
  expect((await res.json()) as unknown[]).toHaveLength(count);
});

Then('the Recents header is visible', async ({ page }) => {
  const home = new HomePage(page);
  await expect(home.recentsSection).toBeVisible();
  await expect(home.recentsSection.getByText('Recents')).toBeVisible();
});

Then('the Recents header is hidden', async ({ page }) => {
  const home = new HomePage(page);
  await expect(home.recentsSection).toBeHidden();
});

Then('{string} is listed under {string} in Recents', async ({ page }, name: string, group: string) => {
  const home = new HomePage(page);
  await expect(home.recentThreadsInGroup(group).filter({ hasText: name })).toBeVisible();
});

When('I click the sidebar New chat button', async ({ page }) => {
  await new HomePage(page).sidebarNewChatButton.click();
});
