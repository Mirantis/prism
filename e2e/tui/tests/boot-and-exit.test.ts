/**
 * Boot + shutdown lifecycle for prism-cli. No Bedrock interaction required —
 * these scenarios exercise the Ink render path, the /exit slash command, and
 * the Ctrl+C → SIGINT shutdown bridge against a running agent-runtime.
 *
 * Written with @amiceli/vitest-cucumber: the Gherkin scenarios live in
 * features/boot-and-exit.feature; the runtime + PTY lifecycle is wired through
 * the BeforeAll/BeforeEach/AfterEach/AfterAll scenario hooks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/boot-and-exit.feature'), 'utf8'),
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
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Boots and renders the header', ({ Then }) => {
    Then('the chat header and input box are visible', async () => {
      // The block-element prism logo always renders on mount; the rounded
      // input border (╭…╮) is part of the input box.
      await session.waitForFrame(/Prism/, 5_000);
      await session.waitForFrame(/╭/, 5_000);
    });
  });

  Scenario('The /exit command shuts down cleanly', ({ When, Then }) => {
    When('I submit the /exit command', async () => {
      // Type the command, wait for the popup to settle, then send Enter so
      // Ink processes the keystrokes as separate events.
      session.send('/exit');
      await session.waitForFrame(/▸\s*\/exit/, 5_000);
      session.send(KEYS.ENTER);
    });
    Then('the CLI shuts down with exit code 0', async () => {
      await session.waitForFrame(/Shutting down/, 20_000);
      const code = await session.waitForExit(30_000);
      expect(code).toBe(0);
    });
  });

  Scenario('Ctrl+C shuts down cleanly', ({ When, Then }) => {
    When('I press Ctrl+C', () => {
      session.send(KEYS.CTRL_C);
    });
    Then('the CLI shuts down with exit code 0', async () => {
      await session.waitForFrame(/Shutting down/, 20_000);
      const code = await session.waitForExit(30_000);
      expect(code).toBe(0);
    });
  });
});
