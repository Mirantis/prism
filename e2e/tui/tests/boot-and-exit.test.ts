/**
 * Boot + shutdown lifecycle for prism-cli. No Bedrock interaction required —
 * these tests exercise the Ink render path, the /exit slash command, and the
 * Ctrl+C → SIGINT shutdown bridge against a running agent-runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPrism, KEYS } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

describe('Prism CLI boot + exit', () => {
  let env: RuntimeTestEnv;

  beforeAll(async () => {
    env = await setupRuntime();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  test('boots and renders the header', async () => {
    const session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    try {
      // The block-element prism logo always renders on mount; the rounded
      // input border (╭…╮) is part of the input box.
      await session.waitForFrame(/Prism/, 30_000);
      await session.waitForFrame(/╭/, 5_000);
    } finally {
      await session.stop();
    }
  });

  test('/exit shuts down cleanly', async () => {
    const session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    try {
      await session.waitForFrame(/Prism/, 30_000);
      // Type the command, wait for the popup to settle, then send Enter so
      // Ink processes the keystrokes as separate events.
      session.send('/exit');
      await session.waitForFrame(/▸\s*\/exit/, 5_000);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/Shutting down/, 20_000);
      const code = await session.waitForExit(30_000);
      expect(code).toBe(0);
    } finally {
      await session.stop();
    }
  });

  test('Ctrl+C shuts down cleanly', async () => {
    const session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    try {
      await session.waitForFrame(/Prism/, 30_000);
      session.send(KEYS.CTRL_C);
      await session.waitForFrame(/Shutting down/, 20_000);
      const code = await session.waitForExit(30_000);
      expect(code).toBe(0);
    } finally {
      await session.stop();
    }
  });
});
