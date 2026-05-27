/**
 * Common Step Definitions — shared Given/When/Then steps.
 */

import { createBdd, DataTable } from 'playwright-bdd';
import * as dbHelper from '../support/db-helper';
import { clearTelemetryBucket } from '../support/s3-helper';

const { Given, Before } = createBdd();

// Store the current agent ID in test context via a module-level variable.
// This works because tests run sequentially (workers: 1).
let currentAgentId: string;

export function getCurrentAgentId(): string {
  return currentAgentId;
}

Before(async () => {
  // Reset DB and telemetry bucket before each scenario, then re-seed
  await dbHelper.resetAll();
  await clearTelemetryBucket();
  const agentId = await dbHelper.seed();
  currentAgentId = agentId;
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

