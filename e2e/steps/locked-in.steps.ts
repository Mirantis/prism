/**
 * Locked-in mode step definitions.
 *
 * The lock's guarantee is about stored state, so every assertion reads the
 * database rather than matching on reply text: the soul document and the memory
 * entries. Each chat scenario ends on one DB assertion and never chains two
 * agent-response assertions: concise mode delivers exactly one bubble per
 * turn.
 *
 * The `agent locked write refused` event is not asserted here. The writer tools
 * are withheld from a locked turn, so the refusal is reachable only on a
 * mid-turn flip. It is covered by the tests in `backend/src/tools/agent_config.rs` and
 * `backend/src/tools/memory.rs`.
 *
 * The locked and unlocked scenarios are pairs, and neither half stands alone.
 * "The stored soul document is unchanged" also passes when the turn failed for a
 * reason that has nothing to do with the lock — a model error, a lost socket, a
 * refusal to use the tool at all. The unlocked control is what rules that out: it
 * sends the same prompt and requires the write to land. Delete either scenario and
 * the other stops proving anything. The memory pair works the same way.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

/** Soul text captured before the turn, so "unchanged"/"changed" is a real comparison. */
let soulBefore = '';

/** Sentinel the prompt asks the agent to write into the soul document. */
const SOUL_MARKER = 'PIRATEMODE7K';

/** Sentinel the prompt asks the agent to store as a long-term memory. */
const MEMORY_MARKER = 'PIRATEMEMO4X';

async function markedMemoryCount(): Promise<number> {
  const prisma = dbHelper.getPrisma();
  return prisma.memoryEntry.count({
    where: { agentId: DEFAULT_AGENT_ID, content: { contains: MEMORY_MARKER } },
  });
}

async function setLockedIn(lockedIn: boolean): Promise<void> {
  const prisma = dbHelper.getPrisma();
  const agent = await prisma.agentWorkspace.update({
    where: { id: DEFAULT_AGENT_ID },
    data: { lockedIn },
  });
  soulBefore = agent.soulMd ?? '';
}

Given('the agent is locked in', async () => {
  await setLockedIn(true);
});

Given('the agent is not locked in', async () => {
  await setLockedIn(false);
});

When('I toggle locked-in to true', async ({ page }) => {
  // Match by role+accessible name: Base UI renders the switch as
  // <span role="switch">, so the aria-label is the accessible name.
  await page.getByRole('switch', { name: 'Locked-in mode' }).click();
  await page.waitForTimeout(500);
});

When('I toggle locked-in to false', async ({ page }) => {
  await page.getByRole('switch', { name: 'Locked-in mode' }).click();
  await page.waitForTimeout(500);
});

Then('the agent details show locked-in is true', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.lockedIn).toBe(true);
});

Then('the agent details show locked-in is false', async ({ page }) => {
  const res = await page.request.get('/agents/details');
  const body = await res.json();
  expect(body.agent.lockedIn).toBe(false);
});

Then('the stored soul document is unchanged', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  const prisma = dbHelper.getPrisma();
  const agent = await prisma.agentWorkspace.findUnique({ where: { id: DEFAULT_AGENT_ID } });
  expect(agent?.soulMd ?? '').toBe(soulBefore);
  expect(agent?.soulMd ?? '').not.toContain(SOUL_MARKER);
});

Then('the stored soul document changes', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  // The control case: without the lock the same request rewrites the document.
  const prisma = dbHelper.getPrisma();
  await expect
    .poll(
      async () => {
        const agent = await prisma.agentWorkspace.findUnique({ where: { id: DEFAULT_AGENT_ID } });
        return agent?.soulMd ?? '';
      },
      { timeout: 30_000 },
    )
    .toContain(SOUL_MARKER);
});

Then('no stored memory entry holds the marker', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  expect(await markedMemoryCount()).toBe(0);
});

Then('a stored memory entry holds the marker', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  // The control for the scenario above: without the lock the same request stores
  // the memory, so "no entry holds the marker" says something about the lock.
  await expect.poll(markedMemoryCount, { timeout: 30_000 }).toBeGreaterThan(0);
});
