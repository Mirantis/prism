/**
 * End-to-end outbound file sharing from the TUI: the agent creates a file in
 * its workspace and shares it (real Bedrock → share_file tool), the CLI renders
 * the attachment on the agent message, and `/save` downloads it to local disk.
 *
 * A unique sentinel in the file body makes the on-disk assertion deterministic
 * without snapshotting free-form generation. The runtime gets a writable temp
 * workspace via SHELL_WORKSPACE_ROOT so shell_write_file/share_file don't hit
 * the non-writable `/home/node` default on CI.
 *
 * Tab path-completion is deliberately NOT exercised here (flaky under the test
 * PTY — see slash-commands.test.ts); /save is driven with an explicit path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const SENTINEL = 'PRISMSHARE_TUI_7';
const SHARED_NAME = 'greeting.txt';

describe('Prism CLI outbound file sharing (/save)', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;
  let workspace: string;
  let saveDir: string;

  beforeAll(async () => {
    // The agent writes files here (shell_write_file) before sharing them.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-share-ws-'));
    env = await setupRuntime({ runtimeEnvOverrides: { SHELL_WORKSPACE_ROOT: workspace } });
  });

  afterAll(async () => {
    await env.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetThread(env.dbPath);
    // Fresh empty download target each test.
    saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-save-out-'));
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
    fs.rmSync(saveDir, { recursive: true, force: true });
  });

  test('agent shares a file it created, and /save writes it to disk', async () => {
    // Ask the agent to create a file and share it back. Explicit filename +
    // sentinel keep the assertions deterministic.
    const prompt =
      `Create a file named ${SHARED_NAME} whose exact contents are "${SENTINEL}", ` +
      `then share that file with me so I can download it. Reply with just "done".`;
    session.send(prompt);
    await sleep(200);
    session.send(KEYS.ENTER);

    // Optimistic user line, then the agent reply with the shared-file chip and
    // the /save hint (MessageList renders "· 📎 <name> ... · /save to download").
    await session.waitForFrame(/▌ You/, 5_000);
    await session.waitForFrame(/▌\s+Prism\b/, 120_000);
    await session.waitForFrame(new RegExp(`📎\\s+${SHARED_NAME}`), 30_000);
    await session.waitForFrame(/\/save to download/, 5_000);

    // Save the shared file to an explicit (absolute) directory.
    session.send(`/save ${saveDir}`);
    await sleep(200);
    session.send(KEYS.ENTER);
    await session.waitForFrame(/Saved 1 file/, 15_000);

    // Authoritative on-disk assertion: the bytes the agent shared landed here.
    const savedPath = path.join(saveDir, SHARED_NAME);
    expect(fs.existsSync(savedPath), `expected ${savedPath} to exist`).toBe(true);
    expect(fs.readFileSync(savedPath, 'utf8')).toContain(SENTINEL);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
