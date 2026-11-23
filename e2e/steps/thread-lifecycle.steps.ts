/**
 * Thread Lifecycle Step Definitions
 */

import { createBdd, DataTable } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

/** The stored Slack thread the scenario opens by its address. */
let slackThreadId = '';

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

// A Slack thread whose history is stored, as a routed Slack thread or a direct message is.
Given('I have a stored Slack thread with the following messages:', async ({}, dataTable: DataTable) => {
  const messages = dataTable.rows().map(([role, content]) => ({ role: role as 'USER' | 'AGENT', content }));
  slackThreadId = await dbHelper.createThread(getCurrentAgentId(), {
    externalThreadId: `1700000000.${Date.now()}`,
    externalChannelId: 'C_MOCK_E2E',
    messages,
  });
});

When("I open that Slack thread's chat address", async ({ page }) => {
  await new HomePage(page).goto(`/chat/${slackThreadId}`);
});

Then('the chat leaves that Slack thread', async ({ page }) => {
  await expect(page).not.toHaveURL(new RegExp(slackThreadId));
});

Then('I should not see the message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  // Wait for chat to be ready (input is visible)
  await expect(homePage.chatInput).toBeVisible({ timeout: 10_000 });
  // Assert the message is not present
  await expect(homePage.getMessageByText(text)).toBeHidden({ timeout: 2_000 });
});
