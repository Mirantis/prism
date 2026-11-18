/**
 * prism started against a runtime that has no LLM credential: the warning under
 * the header names the setting to add.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';
import { noLlmProviderEnv } from '../../support/no-llm-provider-env';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/no-llm-provider.feature'), 'utf8'),
);

let noAwsDir: string;
let env: RuntimeTestEnv;
let session: TuiSession;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    noAwsDir = mkdtempSync(join(tmpdir(), 'tui-e2e-no-aws-'));
    env = await setupRuntime({ runtimeEnvOverrides: noLlmProviderEnv(noAwsDir) });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    rmSync(noAwsDir, { recursive: true, force: true });
  });
  BeforeEachScenario(async () => {
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('prism warns at startup that no LLM provider is configured', ({ Then }) => {
    Then(
      'the screen warns that no LLM provider is configured, naming {string}',
      async (_ctx, setting: string) => {
        await session.waitForFrame(/No LLM provider is configured/, 20_000);
        expect(session.output()).toContain(setting);
      },
    );
  });
});
