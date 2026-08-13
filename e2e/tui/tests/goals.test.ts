/**
 * The /goal slash command lifecycle (list, set, status, pause, resume, stop,
 * and the clear alias), driving the runtime's goal REST API. Runs the real
 * agent loop against Bedrock; each goal-creating scenario stops its goal so no
 * background loop lingers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/goals.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;

async function dispatch(line: string): Promise<void> {
  session.send(line);
  await new Promise((r) => setTimeout(r, 300));
  session.send(KEYS.ENTER);
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario, defineSteps }) => {
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
    await session.stop();
  });

  defineSteps(({ Step }) => {
    Step('I run {string}', async (_ctx, line: string) => {
      await dispatch(line);
    });
    Step('I see {string}', async (_ctx, text: string) => {
      await session.waitForFrame(text, 10_000);
    });
  });

  Scenario('/goal list reports no goals initially', () => {
    // Covered by the shared steps.
  });

  Scenario('set, inspect, pause, resume, and stop a goal', () => {
    // Covered by the shared steps. Pausing early freezes the goal so the
    // status/list assertions read a stable 'paused' state, not the live loop.
  });

  Scenario('/goal clear is an alias for stop', () => {
    // Covered by the shared steps.
  });
});
