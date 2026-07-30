/**
 * End-to-end chat round-trip against real Bedrock via prism-cli → WS →
 * agent-runtime. The prompt constrains the agent's reply so we can assert on a
 * deterministic substring without snapshotting free-form generation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import {
  setupRuntime,
  resetThread,
  countMessages,
  waitForStoredMessage,
  waitForMessageCount,
  type RuntimeTestEnv,
} from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/chat.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;

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
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Sends a prompt and renders the agent reply', ({ When, Then, And }) => {
    When('I send the prompt {string}', async (_ctx, prompt: string) => {
      session.send(prompt);
      // Let ink-text-input commit the appended chars before Enter — without
      // this the keystrokes can race and Enter submits with a stale value.
      await sleep(200);
      session.send(KEYS.ENTER);
    });
    Then('my message appears in the chat', async () => {
      // User line renders optimistically in App.tsx.
      await session.waitForFrame(/▌ You/, 5_000);
    });
    And('the agent reply contains {string}', async (_ctx, sentinel: string) => {
      // The agent prefix proves the round-trip through real Bedrock completed.
      await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      await session.waitForFrame(new RegExp(sentinel), 5_000);
    });
  });

  Scenario('Cancels an in-flight turn when Escape is pressed', ({ When, And, Then }) => {
    When('I send a prompt that keeps the agent busy', async () => {
      // A shell `sleep` keeps the agent busy for a wide cancellation window,
      // so the turn is reliably still in flight when we press Escape.
      session.send('Use your shell to run `sleep 15`, then reply DONE.');
      await sleep(200);
      session.send(KEYS.ENTER);
      // The turn is now in flight — the input shows the "thinking…" spinner.
      await session.waitForFrame(/thinking/, 15_000);
    });
    And('I press Escape while the agent is responding', async () => {
      // Escape cancels: the runtime aborts the LLM generation and the CLI
      // drops a client-side marker for confirmation.
      session.send(KEYS.ESC);
    });
    Then('the chat shows {string}', async (_ctx, marker: string) => {
      await session.waitForFrame(new RegExp(marker), 15_000);
    });
  });

  Scenario('Steers a turn that is already running', ({ When, And, Then }) => {
    When('I send a prompt that keeps the agent busy', async () => {
      session.send('Use your shell to run `sleep 15`, then reply ALPHA.');
      await sleep(200);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/thinking/, 15_000);
    });
    And(
      'I send {string} while the agent is responding',
      async (_ctx, followUp: string) => {
        // The turn is mid-`sleep`. The runtime hands this message to the running
        // turn, which picks it up at its next step — no second turn queues up
        // behind it (which used to leave the history ending on the agent's own
        // reply, a shape Bedrock rejects as assistant prefill).
        session.send(followUp);
        await sleep(200);
        session.send(KEYS.ENTER);
      },
    );
    Then('the agent reply contains {string}', async (_ctx, sentinel: string) => {
      // Asserted against a stored AGENT row, not the frame. The composer now
      // stays live during a turn, so the sentinel is on screen the instant it is
      // typed — a frame matcher would pass against the user's own draft and prove
      // nothing about a reply. Whether the message reached the running turn or its
      // coalesced follow-up, the guarantee is the same: it gets answered, in this
      // conversation.
      await waitForStoredMessage(env.dbPath, 'AGENT', sentinel, 120_000);
      expect(session.output()).not.toMatch(/I encountered an error/i);
    });
    And('the thread has {number} user messages', async (_ctx, expected: number) => {
      // Authoritative: both messages became history, and the mid-turn one was
      // stored exactly once. Polled, because the row is written by the runtime.
      await waitForMessageCount(env.dbPath, 'USER', expected, 30_000);
      expect(countMessages(env.dbPath, 'USER')).toBe(expected);
    });
    And('the running turn answered it, rather than a turn of its own', () => {
      // What makes this a *steering* test: the runtime says it handed the message
      // to the turn that already owned the thread. Without this the scenario would
      // also pass on the old queue-behind-the-lock path, which answered the
      // message late — and produced the assistant-prefill failure this branch
      // fixes.
      expect(env.runtime.logTail(200_000)).toMatch(
        /Handed the message to the turn that owns thread/,
      );
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
