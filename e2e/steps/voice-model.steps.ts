/**
 * Steps about the stand-in voice model itself, shared by every voice feature: the chat
 * header's call, the Computer page's call and the composer's voice message.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import {
  describeBrowser,
  describeExchange,
  takeBaseline,
  waitForModel,
  watchPage,
} from '../support/voice-model';

const { Given, Then } = createBdd();

Given('the voice model has heard nothing yet', async ({ page }) => {
  // The page outlives a navigation later in a scenario, so one attach covers the whole of it.
  watchPage(page);
  const baseline = await takeBaseline();
  expect(baseline.sessions, `a session was still open: ${describeExchange(baseline)}`).toBe(0);
});

Then('the voice model has no session open', async () => {
  await waitForModel(
    'the voice session closing',
    (state) => state.sessions === 0,
    async () => describeBrowser(),
  );
});
