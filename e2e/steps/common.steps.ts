/**
 * Common Step Definitions — shared Given/When/Then steps.
 */

import { createBdd, DataTable } from 'playwright-bdd';
import * as dbHelper from '../support/db-helper';
import { clearTelemetryBucket } from '../support/s3-helper';
import { resetScheduledWork } from '../support/runtime-helper';
import { removeRemoteComputers } from '../support/fake-computer';
import { forgetLlmCacheEntriesSince } from '../support/llm-cache-files';

const { Given, Before, After } = createBdd();

let scenarioStartedAt = 0;

// Store the current agent ID in test context via a module-level variable.
// This works because tests run sequentially (workers: 1).
let currentAgentId: string;

export function getCurrentAgentId(): string {
  return currentAgentId;
}

Before(async () => {
  scenarioStartedAt = Date.now();
  // Unschedule first, wipe second. The DB wipe alone leaves the runtime's
  // in-memory cron timers and goal loops alive with no rows behind them, so a
  // task one scenario scheduled fires inside a later one. See runtime-helper.
  await resetScheduledWork();
  // The runtime keeps its remote computers in memory too, so they go through its API.
  await removeRemoteComputers();
  // Reset DB and telemetry bucket before each scenario, then re-seed
  await dbHelper.resetAll();
  await clearTelemetryBucket();
  const agentId = await dbHelper.seed();
  currentAgentId = agentId;
});

// A failed scenario's recorded responses are dropped, so its retry asks the model again.
After(async ({ $testInfo }) => {
  if ($testInfo.status !== $testInfo.expectedStatus) forgetLlmCacheEntriesSince(scenarioStartedAt);
});

// ========== Given ==========

Given('I am logged in', async ({ page }) => {
  // No-op: the web UI has no auth gate. Kept so existing feature
  // backgrounds stay readable.
});

Given('I have a personal agent', async () => {
  // Agent is created in the Before hook via seed().
  // This step documents the precondition.
});

Given('I have a conversation with the following messages:', async ({}, dataTable: DataTable) => {
  const rows = dataTable.rows();
  const messages = rows.map(([role, content]) => ({
    role: role as 'USER' | 'AGENT',
    content,
  }));
  await dbHelper.createConversation(currentAgentId, messages);
});

