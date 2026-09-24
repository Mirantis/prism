/**
 * Command Palette Step Definitions — the ⌘K / Ctrl+K search over pages,
 * conversations and actions, and where it leaves you: the URL, the breadcrumb
 * and the browser tab's title.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { When, Then } = createBdd();

const palette = (page: Page) => page.getByTestId('command-menu');

When('I open the command palette', async ({ page }) => {
  // Ctrl+K on Linux and Windows, ⌘K on a Mac: the page binds the platform's own modifier.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
});

When('I open the command palette from the sidebar', async ({ page }) => {
  await page.getByTestId('sidebar-search').click();
  await expect(palette(page)).toBeVisible();
});

When('I search the command palette for {string}', async ({ page }, text: string) => {
  await palette(page).getByRole('combobox').fill(text);
});

When('I open the first command palette result', async ({ page }) => {
  await palette(page).getByRole('combobox').press('Enter');
  await expect(palette(page)).toBeHidden();
});

Then('the command palette shows {int} result(s)', async ({ page }, count: number) => {
  await expect(palette(page).getByTestId('command-item')).toHaveCount(count);
});

Then('the command palette result is {string}', async ({ page }, text: string) => {
  await expect(palette(page).getByTestId('command-item')).toHaveText([new RegExp(text)]);
});

Then('the URL is the {string} page', async ({ page }, path: string) => {
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`));
});

Then('the breadcrumb shows the conversation {string}', async ({ page }, title: string) => {
  await expect(page.getByTestId('breadcrumb-conversation')).toHaveText(title);
});

Then('the browser tab title is {string}', async ({ page }, title: string) => {
  await expect(page).toHaveTitle(title);
});

// The desktop sidebar states its width mode on its root; the phone sheet has no such mode.
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]').first();

Then('the sidebar is expanded', async ({ page }) => {
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded');
});

Then('the sidebar is collapsed to icons', async ({ page }) => {
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed');
  await expect(sidebar(page)).toHaveAttribute('data-collapsible', 'icon');
});

When('I press the sidebar shortcut', async ({ page }) => {
  // Ctrl+B on Linux and Windows, ⌘B on a Mac.
  await page.keyboard.press('ControlOrMeta+b');
});
