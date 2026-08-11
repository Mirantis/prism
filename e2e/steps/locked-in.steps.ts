/**
 * Locked-in mode step definitions.
 *
 * The lock's guarantee is about *stored state*, not about what the agent says,
 * so every assertion reads the soul document out of the database rather than
 * matching on reply text — the model's wording for "I can't do that" is not
 * something a test should pin down. Each chat scenario therefore ends on one
 * DB/telemetry assertion and never chains two agent-response assertions
 * (concise mode delivers exactly one bubble per turn, so a second one would
 * just burn its timeout).
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { waitForTelemetryEvent } from '../support/s3-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

/** Soul text captured before the turn, so "unchanged"/"changed" is a real comparison. */
let soulBefore = '';

/**
 * Sentinel the prompt asks the agent to write into the soul document, so
 * "changed" is a specific claim rather than any diff at all.
 */
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

Then('the locked-in toggle is described as a drift guardrail', async ({ page }) => {
  // The shell bypass is open in v1, so the UI must not read as containment.
  await expect(page.getByText(/not a security boundary/i)).toBeVisible({ timeout: 10_000 });
});

Then('the stored soul document is unchanged', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  const prisma = dbHelper.getPrisma();
  const agent = await prisma.agentWorkspace.findUnique({ where: { id: DEFAULT_AGENT_ID } });
  // The authoritative claim: the write did not land. Asserted on the row, not
  // on the reply — the refusal wording belongs to the model.
  expect(agent?.soulMd ?? '').toBe(soulBefore);
  expect(agent?.soulMd ?? '').not.toContain(SOUL_MARKER);
});

Then('a refused locked write is recorded in telemetry', async () => {
  const event = await waitForTelemetryEvent('agent locked write refused', 30_000);
  expect(event.attributes['config.field']).toBe('soulMd');
  // Ids and field names only — the attempted content must never ride along.
  expect(JSON.stringify(event.attributes)).not.toContain(SOUL_MARKER);
});

Then('the stored soul document changes', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();

  // The control case: without the lock the same request rewrites the document,
  // so the scenario above is proving the lock and not just a reluctant model.
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
