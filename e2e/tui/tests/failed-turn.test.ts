/**
 * A turn whose model call fails, against a runtime with an invalid Bedrock key: the agent's
 * error reply, the TUI's failed-turn line, and the OSC 7501 `error` reports of the TUI and
 * the runtime.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';
import { programStatusReports as reports } from '../program-status-reports';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/failed-turn.feature'), 'utf8'),
);

let env: RuntimeTestEnv | undefined;
let session: TuiSession | undefined;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    // Bedrock takes a set bearer token over every other credential, so every model call fails.
    env = await setupRuntime({
      runtimeEnvOverrides: { AWS_BEARER_TOKEN_BEDROCK: 'invalid-e2e-token', PRISM_PROGRAM_STATUS: 'on' },
    });
  });
  AfterAllScenarios(async () => {
    await env?.cleanup();
  });
  BeforeEachScenario(async () => {
    session = startPrism({ env: env!.prismEnv, runtime: env!.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session?.stop();
    session = undefined;
  });

  Scenario('A rejected model credential fails the turn', ({ When, Then, And }) => {
    When('I send a prompt to an agent whose model credential is rejected', async () => {
      // A prompt no other scenario sends, so the e2e LLM cache cannot answer it.
      session!.send('Reply with exactly one word: FAILEDTURN9. No other text.');
      // Let ink-text-input commit the appended chars before Enter.
      await new Promise((resolve) => setTimeout(resolve, 200));
      session!.send(KEYS.ENTER);
    });
    Then('the agent replies that it encountered an error', async () => {
      await session!.waitForFrame(/I encountered an error while processing your request/, 120_000);
    });
    And('the chat shows {string}', async (_ctx, notice: string) => {
      await session!.waitForFrame(new RegExp(notice), 15_000);
    });
    And('the terminal is told the turn failed', async () => {
      await expect
        .poll(() => reports(session!.rawOutput()).at(-1), { timeout: 15_000 })
        .toEqual({ state: 'error', app: 'prism', msg: 'The agent could not answer. Try again.' });
    });
    And("the runtime reports the agent's failure under the agent's name", async () => {
      await expect
        .poll(() => reports(env!.runtime.stdout()).at(-1), { timeout: 15_000 })
        .toEqual({ state: 'error', app: 'prism', title: 'Prism', msg: 'The agent could not answer. Try again.' });
    });
    When('prism exits and the runtime stops', async () => {
      // prism first: a client that reconnects while the runtime shuts down holds the
      // shutdown past the harness's grace period, and a killed runtime writes no report.
      await session!.stop();
      session = undefined;
      await env!.runtime.kill();
    });
    Then('the runtime clears its report', () => {
      expect(reports(env!.runtime.stdout()).at(-1)).toEqual({ state: 'clear' });
    });
  });
});
