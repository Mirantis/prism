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
 * and `deltasSent` grows only if the runtime asked for an answer.
 *
 * Every wait here reports `/state` when it gives up, so a failure names the step
 * of the exchange that did not complete instead of only the assertion that ran.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Locator, type Page } from '@playwright/test';
import { MOCK_REALTIME_PORT } from '../support/mock-realtime-port';

const { Given, When, Then } = createBdd();

const MOCK_STATE_URL = `http://127.0.0.1:${MOCK_REALTIME_PORT}/state`;

/** How much of the microphone counts as the browser reaching the model. */
const MICROPHONE_MS = 500;
/** Long enough for a slow runner to open a socket and pass audio through it. */
const EXCHANGE_TIMEOUT_MS = 30_000;

interface MockState {
  /** How many voice sessions the model has open right now. */
  sessions: number;
  inboundMs: number;
  responsesRequested: number;
  deltasSent: number;
}

/**
 * What the mock had seen when the scenario started.
 *
 * The mock counts for the life of the process, so every assertion here is about
 * growth since this point rather than an absolute figure. Tests run one at a
 * time (`workers: 1`), the same reason `common.steps.ts` keeps the agent id in a
 * module variable.
 */
let baseline: MockState = { sessions: 0, inboundMs: 0, responsesRequested: 0, deltasSent: 0 };

async function readState(): Promise<MockState> {
  const response = await fetch(MOCK_STATE_URL);
  if (!response.ok) {
    throw new Error(`the voice model answered ${response.status} at ${MOCK_STATE_URL}`);
  }
  return (await response.json()) as MockState;
}

/** The whole exchange in one line, for a failure message. */
function describeExchange(state: MockState): string {
  return (
    `voice model: sessions open=${state.sessions}, ` +
    `microphone=${Math.round(state.inboundMs - baseline.inboundMs)}ms, ` +
    `answers requested=${state.responsesRequested - baseline.responsesRequested}, ` +
    `audio frames sent=${state.deltasSent - baseline.deltasSent} ` +
    `(counted since this scenario started)`
  );
}

/**
 * Console errors and uncaught page errors seen since the scenario's baseline.
 *
 * The composer can only say that the audio path did not open; which of the microphone,
 * the audio context and the worklet module refused is in the console. Collected here so a
 * failure names itself from the report instead of needing the browser reopened.
 */
let pageProblems: string[] = [];
const watchedPages = new WeakSet<Page>();

function watchPage(page: Page): void {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on('console', (message) => {
    if (message.type() === 'error') pageProblems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => pageProblems.push(`page error: ${error.message}`));
}

/** What is on screen about the call, and what the page complained about, for the same message. */
async function describeScreen(page: Page): Promise<string> {
  const read = async (testId: string) => {
    const element = page.getByTestId(testId);
    return (await element.count()) > 0 ? ((await element.first().textContent()) ?? '').trim() : null;
  };
  const indicator = await read('voice-call-indicator');
  const error = await read('voice-call-error');
  const button = await read('voice-call-button');
  return (
    `screen: indicator=${indicator === null ? 'absent' : JSON.stringify(indicator)}, ` +
    `refusal=${error === null ? 'none' : JSON.stringify(error)}, ` +
    `control=${button === null ? 'absent' : 'present'}. ` +
    `browser: ${pageProblems.length === 0 ? 'nothing on the console' : pageProblems.join(' | ')}`
  );
}

/**
 * Wait for something the mock can report, and name the step of the exchange that
 * did not complete when it never arrives.
 */
async function waitForModel(
  what: string,
  ok: (state: MockState) => boolean,
  page: Page,
): Promise<void> {
  const deadline = Date.now() + EXCHANGE_TIMEOUT_MS;
  let state = await readState();
  while (!ok(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await readState();
  }
  if (ok(state)) return;
  throw new Error(
    `${what} did not happen within ${EXCHANGE_TIMEOUT_MS}ms. ` +
      `${describeExchange(state)}. ${await describeScreen(page)}`,
  );
}

/** Wait for something on screen, and report the same exchange when it is absent. */
async function waitForScreen(what: string, locator: Locator, page: Page): Promise<void> {
  try {
    await expect(locator).toBeVisible({ timeout: EXCHANGE_TIMEOUT_MS });
  } catch {
    throw new Error(
      `${what} did not appear within ${EXCHANGE_TIMEOUT_MS}ms. ` +
        `${describeExchange(await readState())}. ${await describeScreen(page)}`,
    );
  }
}

const voiceButton = (page: Page) => page.getByTestId('voice-call-button');
const voiceIndicator = (page: Page) => page.getByTestId('voice-call-indicator');
const voiceSpeaking = (page: Page) => page.getByTestId('voice-call-speaking');

Given('the voice model has heard nothing yet', async ({ page }) => {
  // The page outlives the reload later in the scenario, so one attach covers both calls.
  watchPage(page);
  pageProblems = [];
  baseline = await readState();
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
  await waitForScreen(
    'the live indicator',
    voiceIndicator(page).filter({ hasText: 'Voice chat live' }),
    page,
  );
  // One control, and while a call runs it is the one that ends it.
  await expect(voiceButton(page)).toHaveAttribute('aria-label', 'End voice chat');
});

Then('the voice model hears at least half a second of my microphone', async ({ page }) => {
  await waitForModel(
    `${MICROPHONE_MS}ms of the browser's microphone reaching the voice model`,
    (state) => state.inboundMs - baseline.inboundMs >= MICROPHONE_MS,
    page,
  );
});

Then(`the agent's voice is playing in the browser`, async ({ page }) => {
  // The model answers a turn boundary of its own accord, so the request and the
  // frames are the runtime's half of the round trip.
  await waitForModel(
    'the voice model being asked for an answer and streaming it back',
    (state) => state.deltasSent - baseline.deltasSent > 0,
    page,
  );
  // And this is the browser's half: the cue is driven by audio the playback
  // worklet actually played, so it is the page's own evidence that the answer
  // arrived as sound rather than only as frames on the socket.
  await waitForScreen('the speaking cue', voiceSpeaking(page), page);
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
  await waitForModel('the voice session closing', (state) => state.sessions === 0, page);
});
