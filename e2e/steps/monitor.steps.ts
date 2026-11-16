/**
 * Monitor step definitions. The agent's monitor runs a real command in the
 * runtime's workspace, and the test writes the line it waits for.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID, E2E_WORKSPACE } from '../fixtures/test-data';

const { Given, When, Then, After } = createBdd();

/** The files this scenario's monitors watch. */
let watched: string[] = [];

// A monitor outlives its scenario, and a running command keeps the agent working,
// so every later scenario that waits for an idle agent would time out. The e2e
// runtime runs commands on this host: stop the watch, then let the turn its last
// notice starts finish here.
After(async ({ page }) => {
  if (watched.length === 0) return;
  for (const name of watched) spawnSync('pkill', ['-f', name]);
  watched = [];
  await expect
    .poll(async () => ((await (await page.request.get('/agents/state')).json()) as { state: string }).state, {
      timeout: 120_000,
      intervals: [1_000],
    })
    .toBe('idle');
});

Given('the workspace has an empty file {string}', async ({}, name: string) => {
  // The workspace outlives a scenario, so a line an earlier run wrote would match at once.
  fs.writeFileSync(path.join(E2E_WORKSPACE, name), '');
  watched.push(name);
});

Then('the agent started a monitor', async () => {
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
    select: { toolCalls: true },
  });
  const tools = rows.flatMap((row) => (Array.isArray(row.toolCalls) ? (row.toolCalls as Array<{ tool?: string }>) : []));
  expect(tools.map((call) => call.tool)).toContain('monitor');
  // With a monitor running, the agent schedules no check.
  expect(tools.map((call) => call.tool)).not.toContain('schedule_task');
});

When('the line {string} is appended to {string}', async ({}, line: string, name: string) => {
  // The monitor's command has to be reading the file before the line lands.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  fs.appendFileSync(path.join(E2E_WORKSPACE, name), `${line}\n`);
});
