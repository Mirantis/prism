/**
 * End-to-end chat round-trip against real Bedrock via prism-cli → WS →
 * agent-runtime. The prompt constrains the agent's reply so we can assert on a
 * deterministic substring without snapshotting free-form generation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

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
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
