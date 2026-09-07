import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { E2E_WORKSPACE } from '../fixtures/test-data';
import { getTelemetryEvents } from '../support/s3-helper';

const { Given, When, Then } = createBdd();
const filename = 'coding-agent-example.txt';
const file = path.join(E2E_WORKSPACE, filename);

Given('a coding task file contains {string}', async ({}, content: string) => {
  fs.writeFileSync(file, content);
});

When('I ask the coding agent to plan a change', async ({ page }) => {
  test.setTimeout(240_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent in plan mode to read ${filename} and plan changing its contents to exactly after. ` +
    'Poll coding_agent_status until completed and retain its sessionId. Report the plan and sessionId.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(90_000);
});

Then('the coding task file contains {string}', async ({}, content: string) => {
  expect(fs.readFileSync(file, 'utf8').trim()).toBe(content);
});

When('I ask the coding agent to implement its plan', async ({ page }) => {
  const home = new HomePage(page);
  await home.typeMessage(
    'Resume that coding_agent sessionId in edit mode to implement the plan. ' +
    'Poll coding_agent_status until completed. Report the result.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(90_000);
});

Then('the coding task completed through delegation', async ({ page }) => {
  await expect.poll(async () => {
    const events = await getTelemetryEvents();
    return events.filter(e => e.body === 'coding task finished' && e.attributes.status === 'end_turn').length;
  }, { timeout: 30_000 }).toBe(2);
  const events = await getTelemetryEvents();
  const starts = events.filter(e => e.body === 'coding task started');
  const finishes = events.filter(e => e.body === 'coding task finished');
  expect(starts).toHaveLength(2);
  expect(finishes).toHaveLength(2);
  expect(finishes[0].attributes.session_id).toBeTruthy();
  expect(finishes[1].attributes.session_id).toBe(finishes[0].attributes.session_id);
  if (process.env.CODING_AGENT) {
    expect(finishes.every(e => e.attributes.coding_agent === process.env.CODING_AGENT)).toBe(true);
  }
  await expect(new HomePage(page).getAgentMessages()).toHaveCount(2);
});

Given('both coding agents have test credentials', async () => {
  test.skip(!process.env.OPENAI_API_KEY, 'Agent selection needs an OpenAI key alongside the suite’s Bedrock credentials.');
});

When('I ask for a coding task using {string}', async ({ page }, agent: string) => {
  test.setTimeout(180_000);
  const home = new HomePage(page);
  await home.navigate();
  await home.typeMessage(
    `Use coding_agent with agent="${agent}" in edit mode to change ${filename} to exactly after. ` +
    'Poll coding_agent_status until completed. Report which coding agent ran the task and its result.',
  );
  await home.sendMessage();
  await home.waitForStreamComplete(90_000);
});

Then('the coding task used {string}', async ({ page }, agent: string) => {
  await expect.poll(async () => {
    const events = await getTelemetryEvents();
    return events.filter(e => e.body === 'coding task finished' &&
      e.attributes.coding_agent === agent && e.attributes.status === 'end_turn').length;
  }, { timeout: 30_000 }).toBe(1);
  await expect(new HomePage(page).getAgentMessages()).toHaveCount(1);
});
