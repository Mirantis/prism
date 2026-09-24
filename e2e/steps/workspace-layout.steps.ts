import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { When, Then } = createBdd();

When('I open the workspace overview at desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'At a glance' })).toBeVisible();
});

When('I open the workspace overview at phone size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'At a glance' })).toBeVisible();
});

When('I open the workspace page {string} at phone size', async ({ page }, path: string) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('main h1, main h2').first()).toBeVisible();
});

Then('I can open agent settings from the Heartbeat card with Enter', async ({ page }) => {
  const card = page.getByRole('link', { name: 'Heartbeat', exact: true });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText('Agent settings', { exact: true })).toBeVisible();
});

Then('the skip link moves focus to the main content', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

When('I select Chat from the mobile workspace menu', async ({ page }) => {
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  const menu = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'Chat', exact: true }).click();
});

Then('the mobile workspace menu is closed', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).not.toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);
});

Then('the workspace content fits without horizontal scrolling', async ({ page }) => {
  const dimensions = await page.locator('#main-content').evaluate((main) => ({
    content: main.scrollWidth,
    viewport: main.clientWidth,
    document: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.window);
});

When('I choose Create your first task', async ({ page }) => {
  await page.getByRole('button', { name: 'Create your first task' }).click();
});

Then('the task creation form is visible and fits the screen', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'New cron task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Schedule', { exact: true })).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

When('I run the help command enough times to scroll the conversation', async ({ page }) => {
  const input = page.getByPlaceholder('Message your agent...');
  for (let i = 0; i < 5; i++) {
    await input.fill('/help ');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
  }
});

Then('the chat composer fits in the viewport', async ({ page }) => {
  const composer = page.getByPlaceholder('Message your agent...');
  await expect(composer).toBeVisible();
  const bounds = await composer.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeInViewport();
});

Then('the conversation scrolls inside the workspace', async ({ page }) => {
  const messages = page.getByTestId('chat-messages');
  const dimensions = await messages.evaluate((node) => ({
    scroll: node.scrollHeight,
    height: node.clientHeight,
  }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  await messages.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.getByPlaceholder('Message your agent...')).toBeInViewport();
});
