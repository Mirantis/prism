/**
 * End-to-end inbound file sharing from the TUI: /attach uploads a local file
 * to the runtime, the next prompt carries its attachment id, and the agent
 * answers from the file's contents (real Bedrock). The file body plants a
 * sentinel so the assertion is deterministic without snapshotting free-form
 * generation.
 *
 * Tab path-completion is deliberately NOT exercised here — it's flaky under
 * the test PTY; the cli/ unit tests own that logic.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/attach.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
let dir: string;
let filePath: string;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-attach-e2e-'));
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  BeforeEachScenario(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Attaching a file lets the agent read its contents', ({ Given, When, And, Then }) => {
    Given('a local file containing {string}', (_ctx, content: string) => {
      filePath = path.join(dir, 'report.txt');
      fs.writeFileSync(filePath, `${content}\n`);
    });
    When('I attach the file', async () => {
      // The confirmation line proves the multipart upload succeeded and the
      // chip is staged.
      session.send(`/attach ${filePath}`);
      await sleep(200);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/Staged.*report\.txt/, 15_000);
    });
    And('I ask {string}', async (_ctx, prompt: string) => {
      session.send(prompt);
      await sleep(200);
      session.send(KEYS.ENTER);
    });
    Then('my message appears in the chat', async () => {
      await session.waitForFrame(/▌ You/, 5_000);
    });
    And('the agent reply contains {string}', async (_ctx, sentinel: string) => {
      // The reply must contain the sentinel from the file body — proof the
      // attachment flowed WS → chat() → context builder → Bedrock.
      await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      await session.waitForFrame(new RegExp(sentinel), 5_000);
    });
  });
});
