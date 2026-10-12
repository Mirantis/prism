/**
 * Restart Step Definitions
 *
 * The runtime is killed the way a crash or an out-of-memory kill stops it, by
 * SIGKILL in the middle of a turn, and `runtime-supervisor.ts` starts it again
 * on the same database. The page stays open the whole time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { E2E_WORKSPACE } from '../fixtures/test-data';
import { RUNTIME_PID_FILE } from '../support/runtime-pid';

const { Given, When, Then } = createBdd();

/** The file the scenario's shell command touches first, in the workspace that is its cwd. */
const RESTART_MARKER = path.join(E2E_WORKSPACE, 'restart-started.marker');
const HEALTH_URL = 'http://localhost:3003/health';

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(HEALTH_URL)).ok;
  } catch {
    return false;
  }
}

function runtimePid(): number {
  // A runtime this suite reuses rather than starts has no supervisor to start it again.
  expect(fs.existsSync(RUNTIME_PID_FILE), `No supervised runtime: ${RUNTIME_PID_FILE} is missing`).toBe(true);
  return Number(fs.readFileSync(RUNTIME_PID_FILE, 'utf8'));
}

Given('the shell workspace has no restart marker', async () => {
  // A turn, a restart and the resumed turn after it.
  test.setTimeout(600_000);
  // The workspace outlives a scenario, so a marker an earlier run left would
  // read as this run's command having started.
  fs.rmSync(RESTART_MARKER, { force: true });
});

When('the agent has started running the long command', async () => {
  await expect.poll(() => fs.existsSync(RESTART_MARKER), { timeout: 120_000 }).toBe(true);
});

When('the runtime is killed and starts again', async () => {
  const killed = runtimePid();
  process.kill(killed, 'SIGKILL');
  await expect.poll(healthy, { timeout: 30_000 }).toBe(false);
  await expect.poll(() => runtimePid(), { timeout: 30_000 }).not.toBe(killed);
  await expect.poll(healthy, { timeout: 180_000, intervals: [1_000] }).toBe(true);
});

Then('the open conversation shows the agent reply {string}', async ({ page }, sentinel: string) => {
  // The page was open across the restart, so the reply has to reach it on the
  // socket it reconnected by itself.
  const homePage = new HomePage(page);
  await expect(homePage.getAgentMessages().filter({ hasText: sentinel }).first()).toBeVisible({
    timeout: 300_000,
  });
});

Then('the agent owes no reply', async () => {
  await expect
    .poll(() => dbHelper.getPrisma().pendingWork.count({ where: { kind: 'chat' } }), { timeout: 30_000 })
    .toBe(0);
});
