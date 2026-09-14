/**
 * Voice chat step definitions (web).
 *
 * The whole exchange is driven through the real SPA in a real browser: the
 * composer's microphone button opens the call, Chromium's synthetic capture
 * device is the voice, and `support/mock-realtime-server.ts` stands in for
 * OpenAI's Realtime API. No OpenAI account and no host audio are involved.
 *
 * Two sides are asserted, because either can fail on its own. What the user sees
 * comes from the DOM — the live indicator, the speaking cue, the button going
 * back to a startable state. What crossed the wire comes from the mock's
 * `/state`: `inboundMs` grows only if the browser's microphone reached the model,
 * and `deltasSent` grows only if the runtime asked for an answer. A mute is that
 * same `inboundMs` standing still while the session stays open.
 *
 * The waits come from `support/voice-model.ts`, which owns the mock's counters and
 * reports them when a wait gives up, so a failure names the step of the exchange that did
 * not complete instead of only the assertion that ran.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import {
  MICROPHONE_MS,
  describeBrowser,
  describeExchange,
  getBaseline,
  readState,
  takeBaseline,
  waitForModel,
  waitForScreen,
  watchPage,
} from '../support/voice-model';

const { Given, When, Then } = createBdd();

/** A frame already on the wire when the mute landed still arrives, so the count settles first. */
const MUTE_SETTLE_MS = 750;
/** The window that must stay still. A frame is 20ms of audio, so an open microphone fills it. */
const MUTED_WINDOW_MS = 2_000;

/** What the model had heard when the microphone was muted, so the unmute is growth on it. */
let mutedInboundMs = 0;

/** What is on screen about the call, and what the page complained about, for the same message. */
const describeScreen = (page: Page) => async (): Promise<string> => {
  const read = async (testId: string) => {
    const element = page.getByTestId(testId);
    return (await element.count()) > 0 ? ((await element.first().textContent()) ?? '').trim() : null;
  };
  const indicator = await read('voice-call-indicator');
  const error = await read('voice-call-error');
  const button = await read('voice-call-button');
  // The label is the mute's whole state, and it is absent while no call runs.
  const mute =
    (await muteButton(page).count()) > 0
      ? await muteButton(page).getAttribute('aria-label')
      : null;
  return (
    `screen: indicator=${indicator === null ? 'absent' : JSON.stringify(indicator)}, ` +
    `refusal=${error === null ? 'none' : JSON.stringify(error)}, ` +
    `control=${button === null ? 'absent' : 'present'}, ` +
    `mute=${mute ?? 'absent'}. ${describeBrowser()}`
  );
};

const voiceButton = (page: Page) => page.getByTestId('voice-call-button');
const muteButton = (page: Page) => page.getByTestId('voice-mute-button');
const voiceIndicator = (page: Page) => page.getByTestId('voice-call-indicator');
const voiceSpeaking = (page: Page) => page.getByTestId('voice-call-speaking');
const liveIndicator = (page: Page) => voiceIndicator(page).filter({ hasText: 'Voice chat live' });

Given('the voice model has heard nothing yet', async ({ page }) => {
  // The page outlives the reload later in the scenario, so one attach covers both calls.
  watchPage(page);
  mutedInboundMs = 0;
  const baseline = await takeBaseline();
  expect(baseline.sessions, `a session was still open: ${describeExchange(baseline)}`).toBe(0);
});

When('I start a voice chat from the composer', async ({ page }) => {
  // The microphone grant is Playwright's, per origin, so no prompt appears; the
  // click is what opens the device and asks the runtime for a session.
  await voiceButton(page).click();
});

Then('the composer says a voice chat is live', async ({ page }) => {
  // Filtered on the live wording rather than on the indicator alone: the same
  // element says "Starting…" first, so the whole session-open budget belongs to
  // this wait and a runtime that never went live is reported with the exchange.
  await waitForScreen('the live indicator', liveIndicator(page), describeScreen(page));
  // One control, and while a call runs it is the one that ends it.
  await expect(voiceButton(page)).toHaveAttribute('aria-label', 'End voice chat');
});

Then('the voice model hears at least half a second of my microphone', async ({ page }) => {
  await waitForModel(
    `${MICROPHONE_MS}ms of the browser's microphone reaching the voice model`,
    (state) => state.inboundMs - getBaseline().inboundMs >= MICROPHONE_MS,
    describeScreen(page),
  );
});

Then(`the agent's voice is playing in the browser`, async ({ page }) => {
  // The model answers a turn boundary of its own accord, so the request and the
  // frames are the runtime's half of the round trip.
  await waitForModel(
    'the voice model being asked for an answer and streaming it back',
    (state) => state.deltasSent - getBaseline().deltasSent > 0,
    describeScreen(page),
  );
  // And this is the browser's half: the cue is driven by audio the playback
  // worklet actually played, so it is the page's own evidence that the answer
  // arrived as sound rather than only as frames on the socket.
  await waitForScreen('the speaking cue', voiceSpeaking(page), describeScreen(page));
});

When('I mute the microphone', async ({ page }) => {
  await muteButton(page).click();
  // The label is the state, so this is also the evidence that the click landed.
  await expect(muteButton(page)).toHaveAttribute('aria-label', 'Unmute microphone');
});

Then('the voice model hears no more of my microphone', async ({ page }) => {
  await new Promise((resolve) => setTimeout(resolve, MUTE_SETTLE_MS));
  const settled = await readState();
  await new Promise((resolve) => setTimeout(resolve, MUTED_WINDOW_MS));
  const after = await readState();

  expect(
    Math.round(after.inboundMs - settled.inboundMs),
    `the muted microphone still reached the voice model. ` +
      `${describeExchange(after)}. ${await describeScreen(page)()}`,
  ).toBe(0);
  mutedInboundMs = after.inboundMs;

  // A mute is not an ending: the session the call opened is still the one that is open,
  // and the composer still reports a live call.
  expect(after.sessions, `the mute ended the session: ${describeExchange(after)}`).toBe(1);
  await expect(liveIndicator(page)).toBeVisible();
});

When('I unmute the microphone', async ({ page }) => {
  await muteButton(page).click();
  await expect(muteButton(page)).toHaveAttribute('aria-label', 'Mute microphone');
});

Then('the voice model hears my microphone again', async ({ page }) => {
  // On the same session, since nothing here opened a second one.
  await waitForModel(
    'the unmuted microphone reaching the voice model',
    (state) => state.inboundMs > mutedInboundMs && state.sessions === 1,
    describeScreen(page),
  );
});

When('I end the voice chat', async ({ page }) => {
  await voiceButton(page).click();
});

Then('the composer offers a new voice chat', async ({ page }) => {
  await expect(voiceButton(page)).toHaveAttribute('aria-label', 'Voice chat');
  await expect(voiceButton(page)).toBeEnabled();
  await expect(voiceIndicator(page)).toHaveCount(0);
});

Then('the voice model has no session open', async ({ page }) => {
  await waitForModel(
    'the voice session closing',
    (state) => state.sessions === 0,
    describeScreen(page),
  );
});
