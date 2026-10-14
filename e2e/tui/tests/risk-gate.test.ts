/**
 * E2E: the tool risk gate in enforce mode, driven from the terminal UI.
 *
 * The unit tests inject a fake evaluator, and the `risk.*` prompt eval scenarios
 * call the classifier outside a turn. This scenario covers the assembled runtime
 * path: a turn against real Bedrock with `TOOL_RISK_GATE_MODE=enforce`, where a
 * rejected sampling parameter or a schema the model cannot satisfy makes every
 * evaluation fail, and enforce mode then blocks every gated tool. It asserts that
 * an ordinary file write runs and that the gate evaluated the call.
 *
 * The scenario clears the agent guide, because the guide is the policy the gate
 * applies, and a bootstrapped agent holds the seeded guide. Clearing it pins the
 * scenario to the built-in rules, so an edit to that template cannot turn this
 * suite red.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  fs.readFileSync(path.join(import.meta.dirname, '../features/risk-gate.feature'), 'utf8'),
);

/**
 * Written by the scenario, to prove enforce mode lets ordinary work run.
 * Inert on purpose: a name that said "gate" would put the words for the
 * mechanism under test into a call that has to be ALLOWED.
 */
const NOTE_FILE = 'status-note.txt';
const NOTE_BODY = 'PRISMNOTEOK';

/** A model turn plus a classification round trip; deliberately generous. */
const TURN_TIMEOUT_MS = 300_000;

let env: RuntimeTestEnv;
let workspace: string;
let session: TuiSession | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await sleep(500);
  }
  return false;
}

/** The risk-gate classifier calls the runtime has recorded. */
function riskGateCalls(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM llm_calls WHERE purpose = 'risk-gate'")
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

/** Poll until a classifier call is recorded; the runtime writes the row after the call returns. */
async function waitForRiskGateCall(dbPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (riskGateCalls(dbPath) > 0) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Replace the agent guide, which is the policy the gate applies. An empty string
 * clears it, leaving the classifier on its built-in rules alone. The runtime
 * reads the guide per invocation, so this takes effect on the next turn without
 * a restart.
 */
async function setAgentGuide(agentMd: string): Promise<void> {
  await runtimeRequest(env.port, 'PATCH', '/agents/agent-guide', { agentMd });
}

/** Send a prompt and wait for the turn to come back. */
async function ask(prompt: string): Promise<void> {
  if (!session) throw new Error('the TUI session failed to start');
  session.send(prompt);
  await sleep(200);
  session.send(KEYS.ENTER);
  await session.waitForFrame(/▌ You/, 5_000);
  await session.waitForFrame(/▌\s+Prism\b/, TURN_TIMEOUT_MS);
}

describeFeature(
  feature,
  ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
    BeforeAllScenarios(async () => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-ws-'));
      env = await setupRuntime({
        runtimeEnvOverrides: {
          TOOL_RISK_GATE_MODE: 'enforce',
          SHELL_WORKSPACE_ROOT: workspace,
        },
      });
    });
    AfterAllScenarios(async () => {
      // Optional for the same reason as `session` below: when `setupRuntime`
      // throws, this hook still runs, and an unguarded call dies on a TypeError
      // that buries the boot failure and leaks the temp directory.
      await env?.cleanup();
      fs.rmSync(workspace, { recursive: true, force: true });
    });
    BeforeEachScenario(async () => {
      resetThread(env.dbPath);
      fs.rmSync(path.join(workspace, NOTE_FILE), { force: true });
      // cwd, not just SHELL_WORKSPACE_ROOT: the CLI sends its cwd as the
      // thread's workspaceRoot, and `resolveWorkspace()` prefers that over the
      // global root. Without it the agent writes in the CLI package directory
      // while the scenario watches the temp workspace, and fails.
      session = startPrism({
        env: env.prismEnv,
        runtime: env.runtime,
        cwd: workspace,
      });
      await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
    });
    AfterEachScenario(async () => {
      // Optional: a failed spawn otherwise buries the real error under a
      // "cannot read properties of undefined" from the teardown.
      await session?.stop();
      session = undefined;
    });

    Scenario('Ordinary work still runs under enforce mode', ({ Given, When, Then, And }) => {
      Given('my agent guide states no policy', async () => {
        await setAgentGuide('');
      });

      When('I ask the agent to write a note in its workspace', async () => {
        await ask(
          `Create a file named ${NOTE_FILE} in your workspace whose exact contents ` +
            `are "${NOTE_BODY}". Reply with just "done".`,
        );
      });

      Then('the note exists in the workspace', async () => {
        const notePath = path.join(workspace, NOTE_FILE);
        expect(await waitForFile(notePath, 30_000), `expected ${notePath} to exist`).toBe(true);
        expect(fs.readFileSync(notePath, 'utf8')).toContain(NOTE_BODY);
      });

      And('the risk gate evaluated the call', async () => {
        expect(
          await waitForRiskGateCall(env.dbPath, 10_000),
          'expected an llm_calls row with purpose risk-gate',
        ).toBe(true);
      });
    });
  },
);
