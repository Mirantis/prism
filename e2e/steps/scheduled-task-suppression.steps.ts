/**
 * Scheduled-task suppression step definitions (web)
 *
 * Exercises the delivery gate on cron runs: an unconditional task ("reply with
 * exactly X") always delivers, a conditional check whose condition is not met
 * ("only tell me if the year is 1999") runs, records its execution, and posts
 * nothing, and a conditional check whose condition holds on every run posts
 * once.
 *
 * The auth/navigation/chat steps are reused from the other suites. We assert
 * on the database (the `cron_tasks` and `conversation_messages` tables)
 * because the runs happen autonomously after the scheduled delay — and
 * because the silent scenario is about the ABSENCE of a message, which only
 * authoritative state can prove.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

/** Set when the quiet task's row is first observed; bounds the absence query. */
let quietTaskCreatedAt: Date | null = null;

/** The recurring task a scenario created through the API. */
let recurringTask: { id: string; createdAt: Date } | null = null;

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

Given(
  'a recurring scheduled task {string} every {int} seconds with the instruction {string}',
  async ({}, name: string, seconds: number, instruction: string) => {
    // Several runs, each an agent turn, then a quiet period: longer than the default test timeout.
    test.setTimeout(600_000);
    const res = await fetch(`${process.env.AGENT_RUNTIME_URL}/agents/cron-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, schedule: `*/${seconds} * * * * *`, instruction }),
    });
    expect(res.ok).toBe(true);
    const task = (await res.json()) as { id: string; createdAt: string };
    recurringTask = { id: task.id, createdAt: new Date(task.createdAt) };
  },
);

When('the recurring task has run {int} times', async ({}, runs: number) => {
  expect(recurringTask).toBeTruthy();
  const { id } = recurringTask as { id: string };
  // `lastRunAt` moves once per run, after the agent's turn and before the gate
  // and the delivery. A tick that would overlap a running execution is skipped.
  const seen = new Set<number>();
  await pollUntil(
    async () => {
      const row = await dbHelper.getPrisma().cronTask.findUnique({ where: { id } });
      if (row?.lastRunAt) seen.add(row.lastRunAt.getTime());
      return seen.size;
    },
    (count) => count >= runs,
    360_000,
    1000,
  );
  expect(seen.size).toBeGreaterThanOrEqual(runs);
  // Stop further ticks. The last run can still be at its gate or its delivery.
  const res = await fetch(`${process.env.AGENT_RUNTIME_URL}/agents/cron-tasks/${id}`, { method: 'DELETE' });
  expect(res.ok).toBe(true);
});

Then('exactly {int} scheduled-task message is delivered after the recurring task was created', async ({}, count: number) => {
  expect(recurringTask).toBeTruthy();
  const since = (recurringTask as { createdAt: Date }).createdAt;
  const delivered = () =>
    dbHelper.getPrisma().conversationMessage.count({
      where: {
        role: 'AGENT',
        triggeredBy: 'CRON_TASK',
        createdAt: { gte: since },
        thread: { agentId: getCurrentAgentId() },
      },
    });
  // Count once the number has held for a quiet period, so a delivery that the
  // last run makes late is still counted.
  const quietMs = 30_000;
  const start = Date.now();
  let last = await delivered();
  let changedAt = Date.now();
  while (Date.now() - changedAt < quietMs && Date.now() - start < 180_000) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await delivered();
    if (now !== last) {
      last = now;
      changedAt = Date.now();
    }
  }
  expect(last).toBe(count);
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
