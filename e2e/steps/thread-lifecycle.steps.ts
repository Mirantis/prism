/**
 * Thread Lifecycle Step Definitions
 */

import { createBdd, DataTable } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, Then } = createBdd();

Given('I have an older conversation with the following messages:', async ({}, dataTable: DataTable) => {
  const rows = dataTable.rows();
  const messages = rows.map(([role, content]) => ({
    role: role as 'USER' | 'AGENT',
    content,
  }));
  await dbHelper.createOlderConversation(getCurrentAgentId(), messages);
});

Given('I have a Slack-sourced conversation with the following messages:', async ({}, dataTable: DataTable) => {
  const rows = dataTable.rows();
  const messages = rows.map(([role, content]) => ({
    role: role as 'USER' | 'AGENT',
    content,
  }));
  await dbHelper.createSlackConversation(getCurrentAgentId(), messages);
});

Then('I should not see the message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  // Wait for chat to be ready (input is visible)
  await expect(homePage.chatInput).toBeVisible({ timeout: 10_000 });
  // Assert the message is not present
  await expect(homePage.getMessageByText(text)).toBeHidden({ timeout: 2_000 });
});
