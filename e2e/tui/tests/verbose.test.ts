/**
 * Concise delivery in the CLI. Concise (verbose=false, the DB default)
 * publishes only the final result of a multi-step turn, with every step's tool
 * calls folded onto that single message. This asserts the deterministic,
 * CLI-observable outcome: a tool-using turn renders one final answer that still
 * shows the shell_exec tool row. Which intermediate text is/ isn't shown is
 * model-controlled, so it's left to the engine unit tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/verbose.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;

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
    // Concise is the column default; set it explicitly so the scenario is
    // order-independent regardless of any earlier mutation.
    await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: false });
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('A concise tool-using turn delivers a final answer carrying the tool trail', ({ When, Then, And }) => {
    When('I ask the agent to run a shell command and finish with {string}', async (_ctx, final: string) => {
      session.send(
        `Call the shell_exec tool with command: echo prism-cli-9z. After it ` +
        `returns, reply with a one-sentence final summary that ends with the ` +
        `word ${final}.`,
      );
      await sleep(200);
      session.send(KEYS.ENTER);
    });
    Then('the shell_exec tool call is shown', async () => {
      // In concise mode the tool activity folds onto the single final message;
      // the CLI renders it as a "used shell_exec" row.
      await session.waitForFrame(/used shell_exec/, 120_000);
    });
    And('the final reply containing {string} is rendered', async (_ctx, final: string) => {
      await session.waitForFrame(new RegExp(final), 120_000);
    });
  });
});
