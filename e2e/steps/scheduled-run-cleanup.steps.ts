/**
 * A scheduled run that manages the schedule (web)
 *
 * A one-off task reads the schedule, deletes another task and itself, and its reply is still
 * delivered. The steps read the database: the run starts after the scheduled delay, and the
 * delivered message records the run's tool calls.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Then } = createBdd();

/** Task ids by name, read while the tasks exist. */
const taskIds = new Map<string, string>();

Then(
  'the scheduled tasks named {string} and {string} are created for the agent',
  async ({}, first: string, second: string) => {
    const agentId = getCurrentAgentId();
    taskIds.clear();
    await expect
      .poll(
        async () => {
          const tasks = await dbHelper.getPrisma().cronTask.findMany({
            where: { agentId, name: { in: [first, second] } },
          });
          for (const task of tasks) taskIds.set(task.name, task.id);
          return taskIds.size;
        },
        { timeout: 60_000 },
      )
      .toBe(2);
  },
);

Then(
  'the run that delivered {string} deleted the tasks named {string} and {string}',
  async ({}, marker: string, first: string, second: string) => {
    const agentId = getCurrentAgentId();
    const db = dbHelper.getPrisma();
    // The run posts the marker mid-run. Its record, stored beside the post once the run
    // ends, holds the run's tool calls.
    const posted = await db.conversationMessage.findFirst({
      where: { role: 'AGENT', triggeredBy: 'CRON_TASK', content: { contains: marker }, thread: { agentId } },
    });
    expect(posted).not.toBeNull();
    const deletedIds = async () => {
      const rows = await db.conversationMessage.findMany({
        where: { role: 'AGENT', triggeredBy: 'CRON_TASK', thread: { agentId } },
      });
      return rows
        .flatMap((row) => (row.toolCalls ?? []) as { tool: string; input: string; success: boolean }[])
        .filter((call) => call.tool === 'delete_scheduled_task' && call.success)
        .map((call) => (JSON.parse(call.input) as { taskId: string }).taskId);
    };
    await expect
      .poll(deletedIds, { timeout: 60_000 })
      .toEqual(expect.arrayContaining([taskIds.get(first), taskIds.get(second)]));

    const remaining = await db.cronTask.findMany({ where: { agentId, name: { in: [first, second] } } });
    expect(remaining).toEqual([]);
  },
);
