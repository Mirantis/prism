/**
 * End-to-end chat round-trip against real Bedrock via prism-cli → WS →
 * agent-runtime. The prompt is written to constrain the agent's reply so we
 * can assert on a deterministic substring without snapshotting free-form
 * generation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

describe('Prism CLI chat round-trip', () => {
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

  test('sends a prompt and renders the agent reply', async () => {
    // The reply sentinel is a made-up word so we can tell it apart from
    // the user's own echoed prompt in the chronological buffer.
    const prompt = 'Reply with exactly one word: PRISMACK7. No other text.';
    session.send(prompt);
    // Let ink-text-input commit the appended chars before we send Enter —
    // without this, the keystrokes can race and Enter submits with stale value.
    await sleep(200);
    session.send(KEYS.ENTER);

    // User line renders optimistically in App.tsx.
    await session.waitForFrame(/▌ You/, 5_000);

    // Wait for the agent prefix to render — that's evidence the round-trip
    // through real Bedrock completed and the reply landed in the chat.
    await session.waitForFrame(/▌\s+Prism\b/, 120_000);
    // And that the agent's reply contains the sentinel word.
    await session.waitForFrame(/PRISMACK7/, 5_000);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
