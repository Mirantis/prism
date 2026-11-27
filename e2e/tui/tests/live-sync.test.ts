/**
 * E2E: prism-cli while a second client is connected to the same runtime.
 *
 * The runtime shows every message to every open socket, the sender's included.
 * The terminal draws the user's own line when it is sent and the stored copy
 * replaces it by id, so the terminal must show that line once, and must ignore
 * chat on a thread it is not showing.
 *
 * `session.output()` is the whole PTY stream, which holds every repaint, so a count
 * over the stream is meaningless. `session.screen()` is the screen as it stands.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import {
  setupRuntime,
  resetThread,
  runtimeRequest,
  waitForStoredMessage,
  type RuntimeTestEnv,
} from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/live-sync.feature'), 'utf8'),
);

interface ChatFrame {
  type: string;
  payload?: { threadId?: string; role?: string; content?: string };
}

let env: RuntimeTestEnv;
let session: TuiSession;
let second: { socket: WebSocket; frames: ChatFrame[] } | undefined;
let sentPrompt = '';

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    second?.socket.close();
    second = undefined;
    await session.stop();
  });

  Scenario('Shows my own message once', ({ Given, When, Then, And }) => {
    Given('a second client is connected', async () => {
      second = await connectClient(env.port);
    });
    When('I send the prompt {string}', async (_ctx, prompt: string) => {
      sentPrompt = prompt;
      session.send(prompt);
      // Let the text input commit the characters before Enter.
      await sleep(200);
      session.send(KEYS.ENTER);
    });
    Then('the agent reply contains {string}', async (_ctx, sentinel: string) => {
      await waitForStoredMessage(env.dbPath, 'AGENT', sentinel, 120_000);
      await session.waitForFrame(/▌\s+Prism\b/, 30_000);
    });
    And('the second client received my message', async () => {
      // The runtime did deliver the message to other sockets, so the next step
      // tests the sender's own copy and not a runtime that sends nothing.
      await expect
        .poll(() => chatFrames('USER').some((f) => f.payload?.content === sentPrompt), { timeout: 10_000 })
        .toBe(true);
    });
    And('the screen shows my message once', async () => {
      // Give a duplicate copy of the message time to arrive and repaint the frame.
      await sleep(2_000);
      const frame = session.screen();
      expect(frame).toContain('SHOWNONCE7');
      expect(occurrences(frame, '▌ You')).toBe(1);
    });
  });

  Scenario('Ignores a message sent on another thread', ({ Given, When, Then, And }) => {
    let otherThreadId = '';
    Given('a second client is connected', async () => {
      second = await connectClient(env.port);
    });
    When(
      'the second client sends {string} on another thread',
      async (_ctx, prompt: string) => {
        const created = await runtimeRequest<{ threadId: string }>(env.port, 'POST', '/threads', {});
        otherThreadId = created.threadId;
        second!.socket.send(
          JSON.stringify({
            type: 'send',
            id: 'other-thread',
            payload: { message: { id: randomUUID(), threadId: otherThreadId, content: prompt, attachmentIds: [] } },
          }),
        );
      },
    );
    Then('the other thread gets a reply containing {string}', async (_ctx, sentinel: string) => {
      await waitForStoredMessage(env.dbPath, 'AGENT', sentinel, 120_000);
      await expect
        .poll(
          () => chatFrames('AGENT').some((f) => f.payload?.threadId === otherThreadId && f.payload.content?.includes(sentinel)),
          { timeout: 10_000 },
        )
        .toBe(true);
    });
    And('the screen does not show {string}', async (_ctx, sentinel: string) => {
      // The reply went to every socket; give the terminal time to render it if it would.
      await sleep(2_000);
      expect(session.output()).not.toContain(sentinel);
    });
  });
});

/**
 * Open a second chat socket to the runtime, say `hello`, and record every frame
 * it receives. Resolves once the runtime has answered `welcome`.
 */
async function connectClient(port: number): Promise<{ socket: WebSocket; frames: ChatFrame[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const frames: ChatFrame[] = [];
  const welcomed = new Promise<void>((resolve) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as ChatFrame;
      frames.push(frame);
      if (frame.type === 'welcome') resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('second client could not connect')), { once: true });
  });
  socket.send(JSON.stringify({ type: 'hello', id: 'hello', payload: { protocol: 2, client: { name: 'e2e' } } }));
  await welcomed;
  return { socket, frames };
}

function chatFrames(role: 'USER' | 'AGENT'): ChatFrame[] {
  return (second?.frames ?? []).filter((f) => f.type === 'message' && f.payload?.role === role);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
