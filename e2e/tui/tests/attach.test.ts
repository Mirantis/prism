/**
 * End-to-end file sharing from the TUI: /attach uploads a local file to the
 * runtime, the next prompt carries its attachment id, and the agent answers
 * from the file's contents (real Bedrock). The file body plants a sentinel so
 * the assertion is deterministic without snapshotting free-form generation.
 *
 * Tab path-completion is deliberately NOT exercised here — Tab/arrow handling
 * under the test PTY is flaky (see slash-commands.test.ts header); the unit
 * tests in cli/src/attachments.test.ts own that logic.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

describe('Prism CLI /attach round-trip', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;
  let dir: string;
  let filePath: string;

  beforeAll(async () => {
    env = await setupRuntime();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-attach-e2e-'));
    filePath = path.join(dir, 'report.txt');
    fs.writeFileSync(filePath, 'The launch code is ZEBRA42.\n');
  });

  afterAll(async () => {
    await env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
  });

  test('attaches a file and the agent reads its contents', async () => {
    // Stage the file. The confirmation line proves the multipart upload
    // (POST /agents/attachments) succeeded and the chip is staged.
    session.send(`/attach ${filePath}`);
    await sleep(200);
    session.send(KEYS.ENTER);
    await session.waitForFrame(/Staged.*report\.txt/, 15_000);

    // Send a question whose answer only exists inside the attached file.
    const prompt =
      'What launch code is written in the attached file? Reply with only the code, no other text.';
    session.send(prompt);
    await sleep(200);
    session.send(KEYS.ENTER);

    // User line renders optimistically with the 📎 suffix.
    await session.waitForFrame(/▌ You/, 5_000);

    // Agent reply must contain the sentinel from the file body — proof the
    // attachment flowed WS → chat() → context builder → Bedrock.
    await session.waitForFrame(/▌\s+Prism\b/, 120_000);
    await session.waitForFrame(/ZEBRA42/, 5_000);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
