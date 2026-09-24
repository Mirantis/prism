/**
 * Dictation step definitions (web).
 *
 * The Web UI has no dictation control, so the frames go over a WebSocket the page opens
 * on its own origin: the same `/api/ws` path, proxy and runtime the composer's chat uses.
 * `support/mock-realtime-server.ts` stands in for the transcriber, and its transcript
 * states how much speech the committed buffer held, so the text alone shows that the
 * audio crossed the runtime.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { describeExchange, getBaseline, readState } from '../support/voice-model';

const { When, Then } = createBdd();

/** What the page's socket received during the dictation, in order. */
interface Exchange {
  frames: Array<{ type: string; payload?: { text?: string; error?: string } }>;
}

let exchange: Exchange = { frames: [] };

/**
 * Open a socket from the page, dictate one second of a loud tone, and either commit or
 * cancel it. Resolves with every dictation frame and every `error` frame, after the result
 * or a short wait.
 *
 * A commit streams from the moment it starts, before the hello, as a client does from the
 * press. A cancel waits for the hello first, so it discards a recording the transcriber
 * already holds.
 */
async function dictate(page: import('@playwright/test').Page, commit: boolean): Promise<Exchange> {
  return page.evaluate(async (commitIt: boolean) => {
    const frames: Array<{ type: string; payload?: { text?: string; error?: string } }> = [];
    const url = `${location.origin.replace(/^http/, 'ws')}/api/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not open ${url}`));
    });

    let helloArrived: () => void = () => {};
    const hello = new Promise<void>((resolve) => (helloArrived = resolve));

    const finished = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        if (!String(frame.type).startsWith('dictation_') && frame.type !== 'error') return;
        frames.push(frame);
        if (frame.type === 'dictation_hello') helloArrived();
        if (frame.type === 'dictation_result' || frame.type.endsWith('error')) resolve();
      };
    });

    ws.send(JSON.stringify({ type: 'dictation_start', payload: {} }));
    if (!commitIt) await Promise.race([hello, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    // Fifty 20 ms frames of a 440 Hz tone at 24 kHz.
    const rate = 24_000;
    const frameSamples = rate / 50;
    for (let n = 0; n < 50; n += 1) {
      const pcm = new Int16Array(frameSamples);
      for (let i = 0; i < frameSamples; i += 1) {
        pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * (n * frameSamples + i)) / rate) * 20_000);
      }
      ws.send(pcm.buffer);
    }
    ws.send(JSON.stringify({ type: 'dictation_stop', payload: { commit: commitIt } }));

    // A cancelled dictation answers nothing, so its wait ends on time instead.
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, commitIt ? 20_000 : 2_000))]);
    ws.close();
    return { frames };
  }, commit);
}

When('I dictate a second of speech on the chat connection and release', async ({ page }) => {
  exchange = await dictate(page, true);
});

When('I dictate a second of speech on the chat connection and cancel it', async ({ page }) => {
  exchange = await dictate(page, false);
});

Then('the runtime answers the transcript of that second', async () => {
  // No hello: the stop arrived before the transcriber was ready, and a client that has
  // already let go is not told to start recording.
  const result = exchange.frames.find((f) => f.type === 'dictation_result');
  // The mock rounds the speech it heard to 100 ms. A tone is loud in every sample, so a
  // second of it is the whole second.
  expect(result?.payload?.text, `the runtime's frames: ${JSON.stringify(exchange.frames)}`)
    .toBe('Mock dictation of 1000 ms.');
});

Then('the runtime answers no transcript', async () => {
  const types = exchange.frames.map((f) => f.type);
  // The hello is what shows the runtime took the dictation at all.
  expect(types, `the runtime's frames: ${JSON.stringify(exchange.frames)}`).toEqual(['dictation_hello']);
});

Then('the voice model opened a session and transcribed nothing', async () => {
  const state = await readState();
  const baseline = getBaseline();
  expect(state.managedHandshakes - baseline.managedHandshakes, describeExchange(state)).toBe(1);
  expect(state.dictationsTranscribed - baseline.dictationsTranscribed, describeExchange(state)).toBe(0);
});

Then('the voice model transcribed one dictation and was asked for no answer', async () => {
  const state = await readState();
  const baseline = getBaseline();
  expect(state.dictationsTranscribed - baseline.dictationsTranscribed, describeExchange(state)).toBe(1);
  expect(state.responsesRequested - baseline.responsesRequested, describeExchange(state)).toBe(0);
});

