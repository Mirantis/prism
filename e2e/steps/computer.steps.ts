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
  EXCHANGE_TIMEOUT_MS,
  MICROPHONE_MS,
  describeBrowser,
  describeExchange,
  getBaseline,
  readState,
  waitForModel,
  waitForScreen,
} from '../support/voice-model';

const { Given, When, Then } = createBdd();

/** The page starts muted, so this is the window the model must hear nothing in. */
const MUTED_WINDOW_MS = 2_000;

const status = (page: Page) => page.getByRole('status');
const screen = (page: Page) => page.getByLabel("The agent's screen");
const muteButton = (page: Page) => page.getByRole('button', { name: /microphone$/ });
const shareButton = (page: Page) =>
  page.getByRole('button', { name: /^(Share|Stop sharing) your screen$/ });
const recordButton = (page: Page) =>
  page.getByRole('button', { name: /^(Record|Stop recording) your screen$/ });
const speakingCue = (page: Page) => page.getByLabel('Speaking');

/** How long a recording runs for: enough narration to hand over, and more than one look. */
const RECORDING_MS = 4_000;

/** What the page says about the call, and what the browser complained about. */
const describeScreen = (page: Page) => async (): Promise<string> => {
  const read = async (locator: ReturnType<typeof status>) =>
    (await locator.count()) > 0 ? ((await locator.first().textContent()) ?? '').trim() : null;
  // The page states a connection only while it is not live, so an absent one is the
  // live reading rather than a missing element.
  const state = (await read(status(page))) ?? 'live';
  const alert = await read(page.getByRole('alert'));
  const label = async (locator: ReturnType<typeof muteButton>) =>
    (await locator.count()) > 0 ? await locator.first().getAttribute('aria-label') : null;
  const mute = await label(muteButton(page));
  // Both of these say what they would do next, so they report the state they are in. The
  // share matters to a recording failure: a picker the browser refuses leaves no message.
  const share = await label(shareButton(page));
  const record = await label(recordButton(page));
  return (
    `screen: status=${JSON.stringify(state)}, ` +
    `refusal=${alert === null ? 'none' : JSON.stringify(alert)}, ` +
    `canvas=${await canvasSize(page)}, mute=${mute ?? 'absent'}, ` +
    `share=${share ?? 'absent'}, record=${record ?? 'absent'}. ${describeBrowser()}`
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

Given('the runtime can give the agent a computer', async ({ page }) => {
  const response = await fetch('http://localhost:3003/agents/me');
  const { hasComputer } = (await response.json()) as { hasComputer?: boolean };
  if (hasComputer) {
    await returnAbandonedControl(page);
    return;
  }
  // A desktop is what this page is, so there is nothing to assert without one. CI
  // installs the toolchain, so a missing computer there is a broken job rather than a
  // host that was never going to have one — and a scenario that quietly stops running
  // is worse than one that fails.
  if (process.env.CI) {
    throw new Error(
      'the runtime reports no computer: the desktop toolchain is missing on this runner',
    );
  }
  test.skip(true, 'this host has no desktop toolchain, so the agent has no computer');
});

/**
 * Hand the desktop back where a scenario ended while it held control.
 *
 * Closing the viewer keeps the desktop paused for that viewer's return, which is what a
 * person wants and what the next scenario cannot work around: its own computer work would
 * wait for a hand-back nobody is left to give.
 */
async function returnAbandonedControl(page: Page): Promise<void> {
  const paused = async () =>
    (await (await fetch('http://localhost:3003/agents/computer')).json()).paused === true;
  if (!(await paused())) return;
  await page.goto('/computer');
  await page.getByLabel("The agent's screen").waitFor({ timeout: 60_000 });
  // Whichever way back the page offers: a help request left waiting shows its own
  // button and hides the plain one.
  const done = page.getByRole('button', { name: 'I’m done', exact: true });
  const back = page.getByRole('button', { name: 'Return control', exact: true });
  if (await back.count()) await back.click();
  else await done.first().click();
  await expect.poll(paused, { timeout: 30_000 }).toBe(false);
}

/**
 * A screen for the page to share, since this runner has none.
 *
 * `--auto-select-desktop-capture-source` answers the browser's picker by naming a screen,
 * and measured on a machine with no `DISPLAY` there is no screen to name: the picker waits
 * for a person and the share never starts. The suite hands Chromium a synthetic microphone
 * for the same reason, and this is the same substitution for the other half of a
 * recording. What it does not cover is the picker itself, which is the browser's.
 */
async function stubDisplayCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    let step = 0;
    // Redrawn so the screen changes, which is what the page keeps a picture of.
    const draw = () => {
      step += 1;
      if (!ctx) return;
      ctx.fillStyle = `hsl(${(step * 40) % 360} 60% 28%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '88px sans-serif';
      ctx.fillText(`step ${step}`, 90, 380);
    };
    draw();
    setInterval(draw, 1_000);
    navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);
  });
}

When('I open the Computer page', async ({ page }) => {
  // The call opens a real browser for the agent, with a profile of its own. A cold one
  // costs most of the default budget on its own, and this scenario then opens the page a
  // second time after it.
  test.setTimeout(300_000);
  await stubDisplayCapture(page);
  // The microphone grant is Playwright's, per origin, so no prompt appears.
  await page.goto('/computer');
});

Then('the page says the computer is live', async ({ page }) => {
  // The page states a connection only while it is not live, so live is the controls
  // coming alive rather than a word on the screen: both are gated on the same state.
  try {
    await expect(muteButton(page)).toBeEnabled({ timeout: EXCHANGE_TIMEOUT_MS });
  } catch {
    throw new Error(`the call did not go live. ${await describeScreen(page)()}`);
  }
  await expect(status(page)).toContainText(/Ready|Prism is working/);
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
    'the voice answering and streaming it back',
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

When('I record my screen for a few seconds', async ({ page }) => {
  // The picker is answered by `stubDisplayCapture`, installed when the page opened.
  await recordButton(page).click();
  try {
    await expect(recordButton(page)).toHaveAttribute('aria-label', 'Stop recording your screen', {
      timeout: EXCHANGE_TIMEOUT_MS,
    });
  } catch {
    throw new Error(`the recording did not start. ${await describeScreen(page)()}`);
  }
  // Long enough for the narration to reach the voice, and for the sampler to have looked
  // at the screen more than once.
  await new Promise((resolve) => setTimeout(resolve, RECORDING_MS));
});

Then('the voice model hears my narration while the recording runs', async ({ page }) => {
  // The narration travels live, as the rest of the call does; the pictures follow when
  // the recording stops.
  const settled = await readState();
  await waitForModel(
    'the narration reaching the voice model during the recording',
    (state) => state.inboundMs > settled.inboundMs,
    describeScreen(page),
  );
});

When('I stop the recording', async ({ page }) => {
  await recordButton(page).click();
  await expect(recordButton(page)).toHaveAttribute('aria-label', 'Record your screen');
});

Then("the agent's backend is given my screen from the recording", async ({ page }) => {
  await waitForModel(
    'the recording reaching the backend as labelled pictures',
    (state) =>
      state.recordingSegments - getBaseline().recordingSegments > 0 &&
      state.recordingImages - getBaseline().recordingImages > 0,
    describeScreen(page),
  );
});
