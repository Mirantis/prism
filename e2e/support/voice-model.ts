/**
 * What the mock voice model has seen, and the waits the voice steps are built from.
 *
 * Every voice surface — the chat header's call, the composer's voice message and the
 * Computer page's call — is driven through the real SPA against
 * `support/mock-realtime-server.ts`, and all of them read the same counters to tell what
 * crossed the wire from what is merely on screen. The counters run
 * for the life of the mock process, so a scenario takes a baseline and asserts on growth
 * from it. Tests run one at a time (`workers: 1`), which is why one module variable holds
 * that baseline.
 *
 * Every wait here reports the exchange when it gives up, so a failure names the step that
 * did not complete instead of only the assertion that ran. What the page itself showed is
 * the caller's to describe, since the two surfaces show it differently.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';

const STATE_URL = `http://127.0.0.1:${MOCK_REALTIME_PORT}/state`;

/** How much of the microphone counts as the browser reaching the model. */
export const MICROPHONE_MS = 500;
/** Long enough for a slow runner to open a socket and pass audio through it. */
export const EXCHANGE_TIMEOUT_MS = 30_000;
/** Long enough for the agent's own run, on the real chat model, to answer a request. */
export const RUN_TIMEOUT_MS = 120_000;

export interface MockState {
  /** How many calls the model has open right now. */
  sessions: number;
  managedHandshakes: number;
  inboundMs: number;
  /** Requests the voice handed to the runtime, and the ones the runtime answered. */
  delegations: number;
  results: number;
  /** Answers for work the runtime asked for itself, and progress notes while it worked. */
  unpromptedAnswers: number;
  progressNotes: number;
  /** Answers the voice spoke, and the audio frames they took. */
  answers: number;
  deltasSent: number;
  /** What the last call started with. */
  lastStart: { model: string; delegation: string } | null;
  dictationsTranscribed: number;
}

/** What the page showed and complained about, for the same failure message. */
export type DescribeScreen = () => Promise<string>;

let baseline: MockState = {
  sessions: 0,
  managedHandshakes: 0,
  inboundMs: 0,
  delegations: 0,
  results: 0,
  unpromptedAnswers: 0,
  progressNotes: 0,
  answers: 0,
  deltasSent: 0,
  lastStart: null,
  dictationsTranscribed: 0,
};

export async function readState(): Promise<MockState> {
  const response = await fetch(STATE_URL);
  if (!response.ok) {
    throw new Error(`the voice model answered ${response.status} at ${STATE_URL}`);
  }
  return (await response.json()) as MockState;
}

/** Take the baseline every later assertion is growth on, and hand it back. */
export async function takeBaseline(): Promise<MockState> {
  baseline = await readState();
  return baseline;
}

export function getBaseline(): MockState {
  return baseline;
}

/** The whole exchange in one line, for a failure message. */
export function describeExchange(state: MockState): string {
  return (
    `voice model: sessions open=${state.sessions}, ` +
    `microphone=${Math.round(state.inboundMs - baseline.inboundMs)}ms, ` +
    `hand-overs=${state.delegations - baseline.delegations}, ` +
    `answered=${state.results - baseline.results}, ` +
    `answers=${state.answers - baseline.answers}, ` +
    `audio frames sent=${state.deltasSent - baseline.deltasSent}, ` +
    `own answers=${state.unpromptedAnswers - baseline.unpromptedAnswers}, ` +
    `dictations transcribed=${state.dictationsTranscribed - baseline.dictationsTranscribed} ` +
    `(counted since this scenario started)`
  );
}

/**
 * Wait for something the mock can report, and name the step of the exchange that did not
 * complete when it never arrives.
 */
export async function waitForModel(
  what: string,
  ok: (state: MockState) => boolean,
  describeScreen: DescribeScreen,
  timeoutMs = EXCHANGE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState();
  while (!ok(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await readState();
  }
  if (ok(state)) return;
  throw new Error(
    `${what} did not happen within ${timeoutMs}ms. ` +
      `${describeExchange(state)}. ${await describeScreen()}`,
  );
}

/** Wait for something on screen, and report the same exchange when it is absent. */
export async function waitForScreen(
  what: string,
  locator: Locator,
  describeScreen: DescribeScreen,
): Promise<void> {
  try {
    await expect(locator).toBeVisible({ timeout: EXCHANGE_TIMEOUT_MS });
  } catch {
    throw new Error(
      `${what} did not appear within ${EXCHANGE_TIMEOUT_MS}ms. ` +
        `${describeExchange(await readState())}. ${await describeScreen()}`,
    );
  }
}

/**
 * Console errors and uncaught page errors seen since the scenario's baseline.
 *
 * A page can only say that the audio path did not open; which of the microphone, the
 * audio context and the worklet module refused is in the console. Collected here so a
 * failure names itself from the report instead of needing the browser reopened.
 */
let pageProblems: string[] = [];
const watchedPages = new WeakSet<Page>();

export function watchPage(page: Page): void {
  pageProblems = [];
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on('console', (message) => {
    if (message.type() === 'error') pageProblems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => pageProblems.push(`page error: ${error.message}`));
}

export function describeBrowser(): string {
  return `browser: ${pageProblems.length === 0 ? 'nothing on the console' : pageProblems.join(' | ')}`;
}
