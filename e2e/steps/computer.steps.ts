/**
 * Computer page step definitions (web).
 *
 * The page is driven as a user drives it, in a real browser against a real runtime: the
 * route opens the call, Chromium's synthetic capture device is the voice, and
 * `support/mock-realtime-server.ts` stands in for OpenAI's Realtime API. The agent's own
 * browser is a real one too, opened by the runtime on whatever display it has.
 *
 * Three things are asserted, because each fails on its own. The status line is what the
 * user reads. The canvas is the screen stream arriving and decoding — its width is set
 * from the first picture that decoded, so a non-zero one is the whole round trip from the
 * runtime's capture to the page's drawing. And the mock's counters are the call itself.
 *
 * What a real display cannot show is the desktop: on a host that has one the runtime puts
 * the agent's browser there rather than building a desktop around it, so the pointer and
 * keyboard the page would take belong to no desktop and the page says so. That half is
 * covered by unit tests over `DesktopInput` and by a manual run against the container
 * image; see the PR.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import {
  MICROPHONE_MS,
  describeBrowser,
  describeExchange,
  getBaseline,
  readState,
  waitForModel,
  waitForScreen,
} from '../support/voice-model';

const { When, Then } = createBdd();

/** The page starts muted, so this is the window the model must hear nothing in. */
const MUTED_WINDOW_MS = 2_000;

const status = (page: Page) => page.getByRole('status');
const liveStatus = (page: Page) => status(page).filter({ hasText: 'Live' });
const screen = (page: Page) => page.getByLabel("The agent's screen");
const muteButton = (page: Page) => page.getByRole('button', { name: /microphone$/ });
const speakingCue = (page: Page) => page.getByLabel('Speaking');

/** What the page says about the call, and what the browser complained about. */
const describeScreen = (page: Page) => async (): Promise<string> => {
  const read = async (locator: ReturnType<typeof status>) =>
    (await locator.count()) > 0 ? ((await locator.first().textContent()) ?? '').trim() : null;
  const state = await read(status(page));
  const alert = await read(page.getByRole('alert'));
  const mute =
    (await muteButton(page).count()) > 0
      ? await muteButton(page).getAttribute('aria-label')
      : null;
  return (
    `screen: status=${state === null ? 'absent' : JSON.stringify(state)}, ` +
    `refusal=${alert === null ? 'none' : JSON.stringify(alert)}, ` +
    `canvas=${await canvasSize(page)}, mute=${mute ?? 'absent'}. ${describeBrowser()}`
  );
};

/** The size of the picture last drawn, or why there is none. */
async function canvasSize(page: Page): Promise<string> {
  if ((await screen(page).count()) === 0) return 'absent';
  const size = await screen(page).evaluate((canvas) => {
    const c = canvas as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });
  return size.width === 0 ? 'nothing drawn yet' : `${size.width}x${size.height}`;
}

When('I open the Computer page', async ({ page }) => {
  // The call opens a real browser for the agent, with a profile of its own. A cold one
  // costs most of the default budget on its own, and this scenario then runs a second
  // call from the composer after it.
  test.setTimeout(300_000);
  // The microphone grant is Playwright's, per origin, so no prompt appears. Opening the
  // route is the whole gesture: the page asks for the session itself.
  await page.goto('/computer');
});

Then('the page says the computer is live', async ({ page }) => {
  // Filtered on the live wording rather than on the status line alone: the same element
  // says "Connecting…" first, so the whole session-open budget belongs to this wait.
  await waitForScreen('the live status', liveStatus(page), describeScreen(page));
  await waitForModel(
    'the runtime opening a session with the voice model',
    (state) => state.sessions === 1,
    describeScreen(page),
  );
});

Then("the agent's screen is being drawn", async ({ page }) => {
  // The canvas is hidden until the first picture arrives, and its width is set from that
  // picture, so both together are the stream reaching the page and decoding there.
  await waitForScreen("the agent's screen", screen(page), describeScreen(page));
  const drawn = async () =>
    await screen(page).evaluate((canvas) => (canvas as HTMLCanvasElement).width > 0);
  await expect
    .poll(drawn, {
      timeout: 30_000,
      message: `no picture decoded into the canvas. ${await describeScreen(page)()}`,
    })
    .toBe(true);
});

Then('the voice model hears nothing, because the microphone starts muted', async ({ page }) => {
  await expect(muteButton(page)).toHaveAttribute('aria-label', 'Unmute microphone');
  const settled = await readState();
  await new Promise((resolve) => setTimeout(resolve, MUTED_WINDOW_MS));
  const after = await readState();
  expect(
    Math.round(after.inboundMs - settled.inboundMs),
    `the muted microphone still reached the voice model. ` +
      `${describeExchange(after)}. ${await describeScreen(page)()}`,
  ).toBe(0);
});

When('I unmute the microphone on the Computer page', async ({ page }) => {
  await muteButton(page).click();
  // The label is the state, so this is also the evidence that the click landed.
  await expect(muteButton(page)).toHaveAttribute('aria-label', 'Mute microphone');
});

Then("the voice model hears my microphone from the Computer page", async ({ page }) => {
  await waitForModel(
    `${MICROPHONE_MS}ms of the browser's microphone reaching the voice model`,
    (state) => state.inboundMs - getBaseline().inboundMs >= MICROPHONE_MS,
    describeScreen(page),
  );
});

Then("the agent's voice is playing on the Computer page", async ({ page }) => {
  await waitForModel(
    'the voice model being asked for an answer and streaming it back',
    (state) => state.deltasSent - getBaseline().deltasSent > 0,
    describeScreen(page),
  );
  // The page's own evidence: the cue follows audio the playback worklet actually played.
  await waitForScreen('the speaking cue', speakingCue(page), describeScreen(page));
});

When('I leave the Computer page', async ({ page }) => {
  // Leaving is what ends the call: the page has no control that does, by design.
  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
});
