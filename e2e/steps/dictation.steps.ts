/**
 * Voice message step definitions (web).
 *
 * Driven through the real SPA in a real browser: the composer's microphone opens the
 * recording, Chromium's synthetic capture device is the voice, and
 * `support/mock-realtime-server.ts` stands in for the transcriber. Its transcript states
 * how much speech the committed buffer held, so the words in the thread show that the
 * browser's microphone crossed the runtime.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
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

/** The mock's transcript, whatever the fake device happened to play. */
const TRANSCRIPT = /^Mock dictation of \d+ ms\.$/;

const bar = (page: Page) => page.getByTestId('dictation-bar');

/** What the composer shows, for a failure message. */
const describeComposer = (page: Page) => async (): Promise<string> => {
  const read = async (testId: string) => {
    const element = page.getByTestId(testId);
    return (await element.count()) > 0 ? ((await element.first().textContent()) ?? '').trim() : null;
  };
  const recording = await bar(page).count() > 0 ? await bar(page).getAttribute('data-status') : null;
  const error = await read('dictation-error');
  return `composer: bar=${recording ?? 'absent'}, error=${error === null ? 'none' : JSON.stringify(error)}. ${describeBrowser()}`;
};

When('I record a voice message from the composer', async ({ page }) => {
  // The microphone grant is Playwright's, per origin, so no prompt appears.
  await page.getByTestId('dictation-button').click();
  await waitForScreen('the recording', page.locator('[data-testid="dictation-bar"][data-status="recording"]'), describeComposer(page));
  await waitForModel(
    `${MICROPHONE_MS}ms of the browser's microphone reaching the transcriber`,
    (state) => state.inboundMs - getBaseline().inboundMs >= MICROPHONE_MS,
    describeComposer(page),
  );
});

When('I send the voice message', async ({ page }) => {
  await page.getByTestId('dictation-send').click();
});

When('I discard the voice message', async ({ page }) => {
  await page.getByTestId('dictation-cancel').click();
});

Then('my transcribed words appear in the thread as my message', async ({ page }) => {
  const message = page.getByTestId('chat-messages').getByText(TRANSCRIPT);
  await waitForScreen('the transcribed message', message, describeComposer(page));
  // Sent as the user's own message, so the composer is back for the next one.
  await expect(page.getByPlaceholder('Message your agent...')).toBeVisible();
});

Then('the composer offers the text field again', async ({ page }) => {
  await expect(page.getByPlaceholder('Message your agent...')).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByTestId('chat-messages').getByText(TRANSCRIPT)).toHaveCount(0);
});

Then('the voice model transcribed one dictation and was asked for no answer', async () => {
  const state = await readState();
  const baseline = getBaseline();
  expect(state.dictationsTranscribed - baseline.dictationsTranscribed, describeExchange(state)).toBe(1);
  expect(state.responsesRequested - baseline.responsesRequested, describeExchange(state)).toBe(0);
});

Then('the voice model opened a session and transcribed nothing', async () => {
  const state = await readState();
  const baseline = getBaseline();
  expect(state.managedHandshakes - baseline.managedHandshakes, describeExchange(state)).toBe(1);
  expect(state.dictationsTranscribed - baseline.dictationsTranscribed, describeExchange(state)).toBe(0);
});
