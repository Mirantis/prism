/**
 * Ctrl+O tool-call expansion. Prompts the real agent (via prism-cli over WS)
 * to issue a `shell_exec` call against an explicit, identifiable command so
 * we can assert on the input/output blocks once expanded. Also verifies that
 * the Ctrl+O keypress does not leak an `o` into the input field — the
 * `swallowNextChangeRef` race in App.tsx is the regression we care about.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const SENTINEL = 'prism-toolcall';

describe('Prism CLI tool-call expansion', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;

  beforeAll(async () => {
    env = await setupRuntime();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
  });

  test('Ctrl+O expands the latest tool call and Ctrl+O again collapses it', async () => {
    const prompt =
      `You MUST call the shell_exec tool with command: echo ${SENTINEL}` +
      `. After it returns, briefly summarize the output.`;
    session.send(prompt);
    await sleep(200);
    session.send(KEYS.ENTER);

    // Wait for the agent to issue the tool call and the row to render.
    await session.waitForFrame(/used shell_exec[\s\S]*ctrl\+o to expand/, 120_000);

    // Expand.
    session.send(KEYS.CTRL_O);
    await session.waitForFrame(new RegExp(`input[\\s\\S]*echo ${SENTINEL}`), 5_000);
    await session.waitForFrame(new RegExp(`output[\\s\\S]*${SENTINEL}`), 5_000);
    await session.waitForFrame(/ctrl\+o to collapse/, 2_000);

    // Collapse.
    session.send(KEYS.CTRL_O);
    await session.waitForFrame(/ctrl\+o to expand/, 5_000);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
