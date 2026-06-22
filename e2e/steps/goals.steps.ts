/**
 * Goal Step Definitions (web)
 *
 * The chat/navigation/auth steps are reused from the other suites; these add
 * DB-authoritative assertions about the background goal the agent starts in
 * response to a natural-language request. We assert on the `goals` table rather
 * than on-screen text because the loop runs autonomously and asynchronously.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Then } = createBdd();

const TERMINAL = ['complete', 'blocked', 'turn_limited', 'budget_limited', 'stopped'];

/** Poll `fn` until `ok` holds or the timeout elapses; returns the last value. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!ok(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

Then('a goal is created for the agent', async () => {
  const agentId = getCurrentAgentId();
  const goals = await pollUntil(
    () => dbHelper.getPrisma().goal.findMany({ where: { agentId } }),
    (g) => g.length > 0,
    30_000,
  );
  expect(goals.length).toBeGreaterThan(0);
});

Then('the agent runs at least one autonomous goal turn', async () => {
  const agentId = getCurrentAgentId();
  const goals = await pollUntil(
    () => dbHelper.getPrisma().goal.findMany({ where: { agentId } }),
    (g) => g.length > 0 && g[0].turnCount >= 1,
    120_000,
  );
  expect(goals[0]?.turnCount ?? 0).toBeGreaterThanOrEqual(1);
});

Then('the goal reaches a terminal status', async () => {
  const agentId = getCurrentAgentId();
  const goals = await pollUntil(
    () => dbHelper.getPrisma().goal.findMany({ where: { agentId } }),
    (g) => g.length > 0 && TERMINAL.includes(g[0].status),
    180_000,
  );
  expect(TERMINAL).toContain(goals[0]?.status);
});
