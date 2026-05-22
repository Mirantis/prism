/**
 * Navigation Step Definitions
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { AgentDetailPage } from '../pages/agent-detail.page';
import { ProfilePage } from '../pages/profile.page';

const { When, Then } = createBdd();

When('I navigate to the agent chat page', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
});

When('I navigate to the agent detail page', async ({ page }) => {
  const detailPage = new AgentDetailPage(page);
  await detailPage.navigate();
});

When('I navigate to the profile page', async ({ page }) => {
  const profilePage = new ProfilePage(page);
  await profilePage.navigate();
});

Then('I should see the agent name', async ({ page }) => {
  await expect(page.getByText('Test Agent').first()).toBeVisible();
});

Then('the chat input should be visible', async ({ page }) => {
  const homePage = new HomePage(page);
  await expect(homePage.chatInput).toBeVisible();
});
