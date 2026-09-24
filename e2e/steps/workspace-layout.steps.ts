/**
 * Workspace Layout Step Definitions — the skip link, the phone menu, pages at
 * phone width, and the Recents filter box.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

/** A second tab of the same session, on a conversation of its own. */
let secondTab: Page | null = null;

const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

When('I open the overview at desktop size', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Test Agent' })).toBeVisible();
});

When('I open the overview at phone size', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Test Agent' })).toBeVisible();
});

When('I open {string} at phone size', async ({ page }, path: string) => {
  await page.setViewportSize(PHONE);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#main-content')).toBeVisible();
});

When('I press Tab once', async ({ page }) => {
  await page.keyboard.press('Tab');
});

When('I press Enter', async ({ page }) => {
  await page.keyboard.press('Enter');
});

Then('the skip link is focused', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});

Then('the main content is focused', async ({ page }) => {
  await expect(page.locator('#main-content')).toBeFocused();
});

When('I pick {string} from the phone menu', async ({ page }, label: string) => {
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  const menu = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: label, exact: true }).click();
});

Then('the phone menu is closed', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeHidden();
});

Then('the page fits the screen width', async ({ page }) => {
  const widths = await page.locator('#main-content').evaluate((main) => ({
    content: main.scrollWidth,
    pane: main.clientWidth,
    document: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.pane);
  expect(widths.document).toBeLessThanOrEqual(widths.window);
});

Given('{int} conversation threads titled after {string}', async ({}, count: number, stem: string) => {
  // Spaced a minute apart so the newest-first order is fixed.
  const start = Date.now() - count * 60_000;
  for (let i = 1; i <= count; i++) {
    await dbHelper.createThread(getCurrentAgentId(), {
      title: `${stem} ${i}`,
      createdAt: new Date(start + i * 60_000),
    });
  }
});

Then('the Recents filter is shown', async ({ page }) => {
  await expect(page.getByTestId('recents-filter')).toBeVisible();
});

Then('the Recents filter is hidden', async ({ page }) => {
  await expect(page.getByTestId('recents-filter')).toBeHidden();
});

When('I filter Recents by {string}', async ({ page }, text: string) => {
  await page.getByTestId('recents-filter').fill(text);
});

Then('Recents says that no conversation matches', async ({ page }) => {
  await expect(page.getByTestId('recents-no-match')).toBeVisible();
  await expect(new HomePage(page).recentThreads).toHaveCount(0);
});

Then('the agent presence reads {string}', async ({ page }, status: string) => {
  // Working arrives over the socket as the turn starts; Idle returns with the poll the end of
  // the turn refreshes.
  await expect(page.getByTestId('agent-presence')).toHaveAttribute('data-status', status, {
    timeout: 30_000,
  });
});

When('I clear the Recents filter', async ({ page }) => {
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(page.getByTestId('recents-filter')).toBeFocused();
  await expect(page.getByTestId('recents-filter')).toHaveValue('');
});

When('I start a new conversation from the sidebar', async ({ page }) => {
  // The chat page without an id in its address follows the newest conversation, so a
  // conversation created elsewhere would move it; a created one is pinned by its address.
  await new HomePage(page).sidebarNewChatButton.click();
  await page.waitForURL(/\/chat\/[0-9a-f-]+$/);
});

Given('a second tab is open on a new conversation', async ({ context }) => {
  secondTab = await context.newPage();
  await secondTab.goto('/');
  await secondTab.getByTestId('sidebar-new-chat').click();
  await secondTab.getByPlaceholder('Message your agent...').waitFor();
});

Then('the second tab shows the agent working and no response of its own in progress', async () => {
  const tab = secondTab!;
  // The turn is on the first tab's conversation: the mark reports it, and the composer
  // here stays idle, since its STOP button would cancel that turn.
  await expect(tab.getByTestId('agent-presence')).toHaveAttribute('data-status', 'RUNNING', { timeout: 30_000 });
  await expect(tab.getByTestId('chat-stop-button')).toBeHidden();
  await expect(tab.getByTestId('chat-typing-indicator')).toBeHidden();
});

Then('the second tab is closed', async () => {
  await secondTab?.close();
  secondTab = null;
});
