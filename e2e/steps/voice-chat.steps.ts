/**
 * Voice chat step definitions (web).
 *
 * The whole exchange is driven through the real SPA in a real browser: the
 * chat header's call button opens the call, Chromium's synthetic capture
 * device is the voice, and `support/mock-realtime-server.ts` stands in for
 * OpenAI's Realtime API. No OpenAI account and no host audio are involved.
 *
 * Two sides are asserted, because either can fail on its own. What the user sees
 * comes from the DOM — the call bar, the speaking cue, the call button coming
 * back. What crossed the wire comes from the mock's
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
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';
import { HomePage } from '../pages/home.page';
import { MOCK_CALL_SUMMARY } from '../support/mock-call-summary';
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

/** Long enough for the classification model to read a name, through the LLM cache or live. */
const NAME_READING_TIMEOUT_MS = 30_000;

Given('the agent is called {string}', async ({ page }, name: string) => {
  const res = await page.request.patch('/agents/name', { data: { name } });
  expect(res.ok(), `renaming the agent answered ${res.status()}`).toBeTruthy();
  // The rename starts reading the name; the call waits only briefly for it, so the
  // scenario waits here until the reading is stored.
  await expect
    .poll(
      async () => {
        const row = await dbHelper.getPrisma().runtimeState.findUnique({ where: { key: 'agentVoiceReadings' } });
        return row ? (JSON.parse(row.value) as Record<string, string>)[name] : undefined;
      },
      { message: `the reading of the name "${name}"`, timeout: NAME_READING_TIMEOUT_MS },
    )
    .toBeDefined();
});

Then('the voice session speaks with {string}', async ({ page }, voice: string) => {
  await waitForModel(`the voice session asking for the voice "${voice}"`, (state) => state.voice === voice, describeScreen(page));
});

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
  // The header button is a phone while idle and a cancel while the call connects.
  const control =
    (await page.getByTestId('voice-call-cancel').count()) > 0
      ? 'connecting'
      : (await voiceButton(page).count()) > 0
        ? 'idle'
        : 'absent';
  // The label is the mute's whole state, and it is absent while no call runs.
  const mute =
    (await muteButton(page).count()) > 0
      ? await muteButton(page).getAttribute('aria-label')
      : null;
  return (
    `screen: indicator=${indicator === null ? 'absent' : JSON.stringify(indicator)}, ` +
    `refusal=${error === null ? 'none' : JSON.stringify(error)}, ` +
    `control=${control}, ` +
    `mute=${mute ?? 'absent'}. ${describeBrowser()}`
  );
};

const voiceButton = (page: Page) => page.getByTestId('voice-call-button');
const endButton = (page: Page) => page.getByTestId('voice-call-end');
const muteButton = (page: Page) => page.getByTestId('voice-mute-button');
const voiceIndicator = (page: Page) => page.getByTestId('voice-call-indicator');
const voiceSpeaking = (page: Page) => page.getByTestId('voice-call-speaking');

When('I start a voice chat from the chat header', async ({ page }) => {
  // The microphone grant is Playwright's, per origin, so no prompt appears; the
  // click is what opens the device and asks the runtime for a session.
  await voiceButton(page).click();
});

Then('the chat shows the call is live', async ({ page }) => {
  // The call bar's indicator only exists on a live call, so the whole session-open budget
  // belongs to this wait, and a runtime that never went live is reported with the exchange.
  await waitForScreen('the live call bar', voiceIndicator(page), describeScreen(page));
  // While a call runs, the bar ends it and the header offers no second one.
  await expect(endButton(page)).toBeVisible();
  await expect(voiceButton(page)).toHaveCount(0);
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
  mutedInboundMs = 0;
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
  // and the call bar still reports a live call.
  expect(after.sessions, `the mute ended the session: ${describeExchange(after)}`).toBe(1);
  await expect(voiceIndicator(page)).toBeVisible();
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
  await endButton(page).click();
});

Then('the chat header offers a new voice call', async ({ page }) => {
  await expect(voiceButton(page)).toHaveAttribute('aria-label', 'Start voice call');
  await expect(voiceButton(page)).toBeEnabled();
  await expect(voiceIndicator(page)).toHaveCount(0);
});

Then('the composer cannot record a voice message during the call', async ({ page }) => {
  // One microphone per connection, so the composer says why rather than being refused.
  await expect(page.getByTestId('dictation-button')).toBeDisabled();
  await expect(page.getByTestId('dictation-button-hint')).toHaveAttribute(
    'title',
    'End the call to record a voice message',
  );
});

Then('voice used the managed Azure endpoint and credential', async () => {
  const state = await readState();
  expect(state.managedHandshakes).toBeGreaterThan(getBaseline().managedHandshakes);
});

/** The newest conversation, which the scenario seeded or the call continued. */
async function latestThread() {
  const thread = await dbHelper.getPrisma().conversationThread.findFirst({
    where: { agentId: DEFAULT_AGENT_ID, externalThreadId: null },
    orderBy: { createdAt: 'desc' },
  });
  expect(thread, 'no conversation was found for the agent').not.toBeNull();
  return thread!;
}

When('I open my latest conversation', async ({ page }) => {
  await new HomePage(page).goto(`/chat/${(await latestThread()).id}`);
});

Then('the voice session opened with the conversation holding {string}', async ({ page }, held: string) => {
  // The opening item the voice model received, which is the only place the history goes.
  await waitForModel(
    `the opening item holding the conversation line "${held}"`,
    (state) => /<conversation-so-far>[\s\S]*<\/conversation-so-far>/.test(state.contextText) && state.contextText.includes(held),
    describeScreen(page),
  );
});

Then('the conversation shows a summary of the call', async ({ page }) => {
  // The voice model was asked for the summary after the call ended, from the call's own session.
  await waitForModel(
    'the voice model being asked for the summary of the call',
    (state) => state.summariesRequested > getBaseline().summariesRequested,
    describeScreen(page),
  );
  await expect(page.getByText(MOCK_CALL_SUMMARY)).toBeVisible({ timeout: EXCHANGE_TIMEOUT_MS });

  // Stored in the conversation, so the next text turn reads it.
  const thread = await latestThread();
  const stored = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { threadId: thread.id, role: 'AGENT', content: { startsWith: 'Voice call summary:' } },
  });
  expect(stored.map((m) => m.content)).toEqual([`Voice call summary:\n\n${MOCK_CALL_SUMMARY}`]);
});
