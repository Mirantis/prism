/**
 * End-to-end outbound file sharing from the TUI: the agent creates a file in
 * its workspace and shares it (real Bedrock → share_file tool), the CLI renders
 * the attachment on the agent message, and /save downloads it to local disk.
 *
 * A unique sentinel in the file body makes the on-disk assertion deterministic.
 * The runtime gets a writable temp workspace via SHELL_WORKSPACE_ROOT so
 * shell_write_file/share_file don't hit the non-writable `/home/node` default.
 *
 * Written with @amiceli/vitest-cucumber (features/share-file.feature).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/share-file.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
let workspace: string;
let saveDir: string;
// Captured from the prompt step so later steps can assert on them.
let sharedName = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    // The agent writes files here (shell_write_file) before sharing them.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-share-ws-'));
    env = await setupRuntime({ runtimeEnvOverrides: { SHELL_WORKSPACE_ROOT: workspace } });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  BeforeEachScenario(async () => {
    resetThread(env.dbPath);
    saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-out-'));
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
    fs.rmSync(saveDir, { recursive: true, force: true });
  });

  Scenario('The agent shares a created file and /save writes it to disk', ({ When, Then }) => {
    When('I ask the agent to create and share {string} containing {string}', async (_ctx, name: string, content: string) => {
      sharedName = name;
      const prompt =
        `Create a file named ${name} whose exact contents are "${content}", ` +
        `then share that file with me so I can download it. Reply with just "done".`;
      session.send(prompt);
      await sleep(200);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/▌ You/, 5_000);
    });
    Then('the shared file appears with a save hint', async () => {
      // The agent reply with the shared-file chip and the /save hint
      // ("· 📎 <name> ... · /save to download").
      await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      await session.waitForFrame(new RegExp(`📎\\s+${sharedName}`), 30_000);
      await session.waitForFrame(/\/save to download/, 5_000);
    });
    When('I run /save into a local directory', async () => {
      session.send(`/save ${saveDir}`);
      await sleep(300);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/Saved 1 file/, 15_000);
    });
    Then('{string} is written to disk containing {string}', (_ctx, name: string, content: string) => {
      // Authoritative on-disk assertion: the bytes the agent shared landed here.
      const savedPath = path.join(saveDir, name);
      expect(fs.existsSync(savedPath), `expected ${savedPath} to exist`).toBe(true);
      expect(fs.readFileSync(savedPath, 'utf8')).toContain(content);
    });
  });
});
