/**
 * A call on the agent's computer, from the chat request to the voice leaving.
 *
 * The agent joins a local call page with its computer tools and connects its voice with
 * `join_call`. The page reports what its microphone heard to the test's own server, and
 * the mock voice model reports what it heard, so each direction of the audio has its own
 * witness.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { startCallSite } from '../support/call-site';
import { describeBrowser, getBaseline, MICROPHONE_MS, RUN_TIMEOUT_MS, waitForModel } from '../support/voice-model';

const { Given, When, Then, After } = createBdd();
let site: Awaited<ReturnType<typeof startCallSite>> | undefined;

/** The call page's microphone this loud has heard the agent's voice, not line noise. */
const VOICE_RMS = 0.05;
/** A turn that drives a browser and then connects a voice. */
const TURN_TIMEOUT_MS = 180_000;

After(async ({ page }) => {
  // A scenario that failed mid-call would leave the runtime holding the one voice, and
  // every later voice scenario would be refused. Ask Prism to leave, best effort.
  if (site?.state().joined && !site.state().left) {
    await ask(page, 'Leave the call now.').catch(() => undefined);
  }
  await site?.close();
  site = undefined;
});

Given('a call page on the web', async () => {
  site = await startCallSite();
});

async function ask(page: import('@playwright/test').Page, message: string): Promise<void> {
  const home = new HomePage(page);
  await home.typeMessage(message);
  await home.sendMessage();
  await home.waitForAgentResponse(TURN_TIMEOUT_MS);
  await home.waitForStreamComplete(TURN_TIMEOUT_MS);
}

function describeCall(): string {
  return `call page: ${JSON.stringify(site?.state())}. ${describeBrowser()}`;
}

When('I ask Prism to join the call using its computer', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/chat');
  await ask(page, `Join my team call at ${site!.url} with your computer and take part by voice.`);
});

Then("Prism's browser joined the call", async () => {
  expect(site!.state().joined, describeCall()).toBe(true);
});

Then('the voice model hears the call', async () => {
  await waitForModel(
    'the call reaching the voice model',
    (state) => state.sessions === 1 && state.inboundMs - getBaseline().inboundMs >= MICROPHONE_MS,
    async () => describeCall(),
  );
});

Then("the call hears Prism's voice", async () => {
  await waitForModel(
    'the voice model answering the call',
    (state) => state.deltasSent > getBaseline().deltasSent,
    async () => describeCall(),
    RUN_TIMEOUT_MS,
  );
  await expect
    .poll(() => site!.state().micPeak, { timeout: 30_000, message: describeCall() })
    .toBeGreaterThan(VOICE_RMS);
});

When('I ask Prism to leave the call', async ({ page }) => {
  await ask(page, 'Leave the call now.');
});

Then('the call page shows Prism left', async () => {
  await expect.poll(() => site!.state().left, { timeout: 30_000, message: describeCall() }).toBe(true);
});
