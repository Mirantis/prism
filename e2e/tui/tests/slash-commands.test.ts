/**
 * Slash-command UI: popup visibility on '/', and direct dispatch via
 * typing the full command name + Enter. None of these scenarios call the
 * LLM — slash commands run locally inside prism-cli.
 *
 * Tab autocomplete and arrow-key navigation are exercised manually via
 * `npm run dev --workspace=prism-cli` — under the test PTY they run into
 * Ink keystroke parsing quirks that aren't worth chasing here, and the
 * main regression risk (the `swallowNextChangeRef` ordering with Ctrl+O)
 * is covered by tool-calls.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

describe('Prism CLI slash commands', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;

  beforeAll(async () => {
    env = await setupRuntime();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
  });

  test('typing / shows the command popup with /copy and /exit', async () => {
    session.send('/');
    await session.waitForFrame(/\/copy/, 5_000);
    await session.waitForFrame(/\/exit/, 5_000);
    await session.waitForFrame(/▸\s*\/copy/, 2_000);
  });

  test('typing /copy + Enter dispatches the command', async () => {
    // Direct dispatch — bypasses Tab. /copy with no prior message returns
    // the "No message to copy yet." SYSTEM line.
    session.send('/copy');
    await session.waitForFrame(/▸\s*\/copy/, 5_000);
    session.send(KEYS.ENTER);
    await session.waitForFrame(/No message to copy yet/, 5_000);
  });
});
