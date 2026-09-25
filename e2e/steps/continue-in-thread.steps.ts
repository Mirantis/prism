/**
 * Continue-in-thread step definitions (web)
 *
 * Exercises the "wait & resume here" flow: a one-off scheduled task created with
 * continueInThread runs against — and delivers back into — the originating
 * conversation thread instead of broadcasting to the latest thread.
 *
 * The auth/navigation/chat steps are reused from the other suites. We assert on
 * the database (the `cron_tasks` and `conversation_messages` tables) rather than
 * on-screen text because the resume runs autonomously and asynchronously after
 * the scheduled delay.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Then } = createBdd();

/** The thread the bound task is tied to — captured in the first step, asserted in the second. */
let boundThreadId: string | null = null;

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

Then('a thread-bound scheduled task is created for the agent', async () => {
  const agentId = getCurrentAgentId();
  // The one-off task exists until its run ends: a 20s delay, then the run, then
  // the auto-delete. This poll samples every 1.5s, well within that window.
  const tasks = await pollUntil(
    () => dbHelper.getPrisma().cronTask.findMany({ where: { agentId, threadId: { not: null } } }),
    (t) => t.length > 0,
    60_000,
  );
  expect(tasks.length).toBeGreaterThan(0);
  boundThreadId = tasks[0].threadId;
  expect(boundThreadId).toBeTruthy();
});

Then('the agent posts a follow-up in that same thread when the task fires', async () => {
  expect(boundThreadId).toBeTruthy();
  // The resumed run delivers a CRON_TASK-triggered agent message into the SAME
  // thread the task was bound to (not a fresh one).
  const messages = await pollUntil(
    () =>
      dbHelper.getPrisma().conversationMessage.findMany({
        where: { threadId: boundThreadId as string, role: 'AGENT', triggeredBy: 'CRON_TASK' },
      }),
    (m) => m.length > 0,
    150_000,
  );
  expect(messages.length).toBeGreaterThan(0);
});
