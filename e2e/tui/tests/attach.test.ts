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
import { crc32, deflateRawSync } from 'node:zlib';
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

/**
 * Build a minimal valid ZIP archive containing one deflated text file.
 */
function createZipBuffer(innerFilename: string, innerContent: string): Buffer {
  const content = Buffer.from(innerContent, 'utf8');
  const compressed = deflateRawSync(content);
  const fnameBytes = Buffer.from(innerFilename, 'utf8');
  const checksum = crc32(content);

  // Local file header
  const local = Buffer.alloc(30 + fnameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // compression: deflate
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fnameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  fnameBytes.copy(local, 30);

  const localFileData = Buffer.concat([local, compressed]);

  // Central directory entry
  const central = Buffer.alloc(46 + fnameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(8, 10); // compression: deflate
  central.writeUInt16LE(0, 12); // mod time
  central.writeUInt16LE(0, 14); // mod date
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fnameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra field length
  central.writeUInt16LE(0, 32); // file comment length
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal file attributes
  central.writeUInt32LE(0, 38); // external file attributes
  central.writeUInt32LE(0, 42); // relative offset of local header
  fnameBytes.copy(central, 46);

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // central dir size
  eocd.writeUInt32LE(localFileData.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localFileData, central, eocd]);
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
      //
      // The sentinel renders as the reply streams; under Opus 4.8 the reply is
      // slower to stream, so the post-reply wait is generous (was 5s — too
      // tight, timed out in CI once the reply header had appeared).
      await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      await session.waitForFrame(new RegExp(sentinel), 60_000);
    });
  });

  Scenario('Attaching a zip file lets the agent inspect its contents', ({ Given, When, And, Then }) => {
    Given('a local zip file containing a text file {string} with {string}', (_ctx, innerFile: string, innerContent: string) => {
      filePath = path.join(dir, 'bundle.zip');
      const zipBuf = createZipBuffer(innerFile, innerContent);
      fs.writeFileSync(filePath, zipBuf);
    });
    When('I attach the file', async () => {
      session.send(`/attach ${filePath}`);
      await sleep(200);
      session.send(KEYS.ENTER);
      await session.waitForFrame(/Staged.*bundle\.zip/, 15_000);
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
      await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      await session.waitForFrame(new RegExp(sentinel), 60_000);
    });
  });
});
