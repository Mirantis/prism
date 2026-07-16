/**
 * Verbose / concise delivery mode step definitions.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

Given('the agent is in concise mode', async () => {
  const prisma = dbHelper.getPrisma();
  await prisma.agentWorkspace.update({
    where: { id: DEFAULT_AGENT_ID },
    data: { verbose: false },
  });
});

Given('the agent is in verbose mode', async () => {
  const prisma = dbHelper.getPrisma();
  await prisma.agentWorkspace.update({
    where: { id: DEFAULT_AGENT_ID },
    data: { verbose: true },
  });
});

When('a multi-step chat turn completes', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
  await homePage.typeMessage('Use a tool and then respond with a summary.');
  await homePage.sendMessage();
  await homePage.waitForStreamComplete();
});

Then('only one agent message is delivered via the channel', async ({ page }) => {
  const homePage = new HomePage(page);
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages).toHaveCount(1, { timeout: 15_000 });
});

Then('the database contains multiple AGENT rows for the thread', async () => {
  const prisma = dbHelper.getPrisma();
  const count = await prisma.conversationMessage.count({
    where: { role: 'AGENT' },
  });
  expect(count).toBeGreaterThan(1);
});

Then('multiple agent messages are delivered via the channel', async ({ page }) => {
  const homePage = new HomePage(page);
  const agentMessages = homePage.getAgentMessages();
  const count = await agentMessages.count();
  expect(count).toBeGreaterThan(1);
});

Then('the agent details show verbose is true', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.verbose).toBe(true);
});

Then('the agent details show verbose is false', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.verbose).toBe(false);
});

When('I toggle verbose to true', async ({ page }) => {
  const toggle = page.getByLabel('Verbose delivery');
  await toggle.click();
  await page.waitForTimeout(500);
});

When('I toggle verbose to false', async ({ page }) => {
  const toggle = page.getByLabel('Verbose delivery');
  await toggle.click();
  await page.waitForTimeout(500);
});
