/**
 * Locked-in mode step definitions.
 *
 * The lock's guarantee is about stored state, so every assertion reads the soul
 * document out of the database rather than matching on reply text. Each chat
 * scenario ends on one DB assertion and never chains two agent-response
 * assertions: concise mode delivers exactly one bubble per turn.
 *
 * The `agent locked write refused` event is not asserted here. The writer tools
 * are withheld from a locked turn, so the refusal is reachable only on a
 * mid-turn flip. It is covered in `src/tools/__tests__/agent-config.test.ts`.
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
