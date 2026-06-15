/**
 * Ctrl+O tool-call expansion. Prompts the real agent (via prism-cli over WS)
 * to issue a `shell_exec` call against an explicit, identifiable command so we
 * can assert on the input/output blocks once expanded. Also verifies that the
 * Ctrl+O keypress does not leak an `o` into the input field — the
 * `swallowNextChangeRef` race in App.tsx is the regression we care about.
 *
 * Written with @amiceli/vitest-cucumber (features/tool-calls.feature).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/tool-calls.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
// The echoed command sentinel, captured from the prompt for the later asserts.
let sentinel = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  Scenario('Ctrl+O expands the latest tool call and again collapses it', ({ When, Then, And }) => {
    When('I ask the agent to run a shell command echoing {string}', async (_ctx, echoed: string) => {
      sentinel = echoed;
      const prompt =
        `You MUST call the shell_exec tool with command: echo ${echoed}` +
        `. After it returns, briefly summarize the output.`;
      session.send(prompt);
      await sleep(200);
      session.send(KEYS.ENTER);
    });
    Then('the tool-call row can be expanded', async () => {
      await session.waitForFrame(/used shell_exec[\s\S]*ctrl\+o to expand/, 120_000);
    });
    When('I press Ctrl+O', () => {
      session.send(KEYS.CTRL_O);
    });
    Then('the tool call input and output are shown', async () => {
      await session.waitForFrame(new RegExp(`input[\\s\\S]*echo ${sentinel}`), 5_000);
      await session.waitForFrame(new RegExp(`output[\\s\\S]*${sentinel}`), 5_000);
    });
    And('the tool-call row can be collapsed', async () => {
      await session.waitForFrame(/ctrl\+o to collapse/, 2_000);
    });
    When('I press Ctrl+O again', () => {
      session.send(KEYS.CTRL_O);
    });
    Then('the tool-call row is collapsed again', async () => {
      await session.waitForFrame(/ctrl\+o to expand/, 5_000);
    });
  });
});
