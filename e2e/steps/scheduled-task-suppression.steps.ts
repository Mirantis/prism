/**
 * Scheduled-task suppression step definitions (web)
 *
 * Exercises the DELIVER/SUPPRESS gate on cron runs: an unconditional task
 * ("reply with exactly X") always delivers, while a conditional check whose
 * condition is not met ("only tell me if the year is 1999") runs, records its
 * execution, and posts nothing.
 *
 * The auth/navigation/chat steps are reused from the other suites. We assert
 * on the database (the `cron_tasks` and `conversation_messages` tables)
 * because the runs happen autonomously after the scheduled delay — and
 * because the silent scenario is about the ABSENCE of a message, which only
 * authoritative state can prove.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Then } = createBdd();

/** Set when the quiet task's row is first observed; bounds the absence query. */
let quietTaskCreatedAt: Date | null = null;

/** Poll `fn` until `ok` holds or the timeout elapses; returns the last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1500,
): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!ok(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

Then('a scheduled task named {string} is created for the agent', async ({}, name: string) => {
  const agentId = getCurrentAgentId();
  // The one-off task exists until its run ends: a 20s delay, then the run, then
  // the auto-delete. This poll samples every 1.5s, well within that window.
  const tasks = await pollUntil(
    () => dbHelper.getPrisma().cronTask.findMany({ where: { agentId, name } }),
    (t) => t.length > 0,
    60_000,
  );
  expect(tasks.length).toBeGreaterThan(0);
  quietTaskCreatedAt = tasks[0].createdAt;
});

Then('a scheduled-task message containing {string} is delivered', async ({}, marker: string) => {
  const agentId = getCurrentAgentId();
  const messages = await pollUntil(
    () =>
      dbHelper.getPrisma().conversationMessage.findMany({
        where: {
          role: 'AGENT',
          triggeredBy: 'CRON_TASK',
          content: { contains: marker },
          thread: { agentId },
        },
      }),
    (m) => m.length > 0,
    150_000,
  );
  expect(messages.length).toBeGreaterThan(0);
});

Then('the scheduled task named {string} runs to completion', async ({}, name: string) => {
  const agentId = getCurrentAgentId();
  // A one-off task auto-deletes after its run, so the row disappearing proves
  // the run executed and its bookkeeping (including the delete) was unaffected
  // by suppression.
  const remaining = await pollUntil(
    () => dbHelper.getPrisma().cronTask.findMany({ where: { agentId, name } }),
    (t) => t.length === 0,
    150_000,
  );
  expect(remaining.length).toBe(0);
});

Then('the quiet task has written {string} to memory', async ({}, marker: string) => {
  const agentId = getCurrentAgentId();
  // The memory write is the proof the run itself succeeded: a run that crashed
  // before the gate would also leave no message, so message absence alone
  // would falsely certify suppression.
  const entries = await pollUntil(
    () =>
      dbHelper.getPrisma().memoryEntry.findMany({
        where: { agentId, content: { contains: marker } },
      }),
    (m) => m.length > 0,
    30_000,
  );
  expect(entries.length).toBeGreaterThan(0);
});

Then('no scheduled-task message is delivered after the quiet task was created', async () => {
  const agentId = getCurrentAgentId();
  expect(quietTaskCreatedAt).toBeTruthy();
  // Delivery happens inside the run, before the one-shot auto-delete observed
  // by the previous step — so any message would already exist. Keep a short
  // grace window anyway before asserting the absence.
  await new Promise((r) => setTimeout(r, 10_000));
  const messages = await dbHelper.getPrisma().conversationMessage.findMany({
    where: {
      role: 'AGENT',
      triggeredBy: 'CRON_TASK',
      createdAt: { gte: quietTaskCreatedAt as Date },
      thread: { agentId },
    },
  });
  expect(messages).toEqual([]);
});
