/**
 * E2E: an oversized tool result is cut for the model, saved whole, and searchable.
 *
 * This is the one property no unit test can reach, because it spans two turns
 * through real persistence: turn 1 cuts and saves, the row is written, and turn 2
 * rebuilds its context from that row. The defect this guards against was exactly
 * a cross-turn one — the cap held for the turn that produced the result and the
 * raw payload came back whole on every turn after.
 *
 * Terminal assertions are kept to "did the agent say the marker", because
 * `session.output()` is the whole accumulated PTY stream. Everything else is
 * asserted against authoritative state: the `conversation_messages` row and the
 * file under `<dataDir>/tool-outputs`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  fs.readFileSync(path.join(import.meta.dirname, '../features/large-tool-output.feature'), 'utf8'),
);

/**
 * Sits at the exact middle of the payload, which is the region a head+tail cut
 * removes — so finding it proves the saved copy was read, not the preview.
 */
const MARKER = 'MIDDLE-MARKER-4T7X the answer is chartreuse';
const FILLER_LINES = 12_000;
const BIG_FILE = 'huge-output.txt';

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
let dataDir = '';
let workspaceDir = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface StoredToolCall {
  tool: string;
  output: string;
  rendered?: boolean;
  truncated?: { totalChars: number; keptChars: number; omittedChars: number; spillId?: string };
}

/** Every tool call the agent has recorded, newest message last. */
function storedToolCalls(dbPath: string): StoredToolCall[] {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT toolCalls FROM conversation_messages WHERE toolCalls IS NOT NULL ORDER BY createdAt ASC")
      .all() as Array<{ toolCalls: string }>;
    return rows.flatMap((r) => JSON.parse(r.toolCalls) as StoredToolCall[]);
  } finally {
    db.close();
  }
}

function latestContextTokens(dbPath: string): number | null {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare('SELECT contextTokens FROM conversation_threads ORDER BY updatedAt DESC LIMIT 1')
      .get() as { contextTokens: number | null } | undefined;
    return row?.contextTokens ?? null;
  } finally {
    db.close();
  }
}

/** Poll until a tool call matching `name` has been persisted. */
async function waitForToolCall(
  dbPath: string,
  name: string,
  timeoutMs = 180_000,
): Promise<StoredToolCall> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = storedToolCalls(dbPath).find((tc) => tc.tool === name);
    if (found) return found;
    await sleep(1000);
  }
  throw new Error(`no ${name} tool call was persisted within ${timeoutMs}ms`);
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-spill-'));
    dataDir = path.join(root, 'data');
    workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    env = await setupRuntime({
      runtimeEnvOverrides: {
        // So the saved copies land somewhere this test can look at, rather than in
        // the developer's (or CI's) real ~/.prism.
        PRISM_DATA_DIR: dataDir,
        SHELL_WORKSPACE_ROOT: workspaceDir,
      },
    });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session!.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session?.stop();
  });

  Scenario('The agent searches the part of a result it was never shown', ({ Given, When, Then, And }) => {
    Given("the agent's workspace holds a file too large to return whole", () => {
      resetThread(env.dbPath);

      // ~40 chars a line, marker at the exact middle, so the payload is well past
      // the 30,000-char chat budget and the marker is deep inside the omitted part.
      const half = Array.from({ length: FILLER_LINES / 2 }, (_, i) =>
        `line ${String(i).padStart(6, '0')}: ${'filler '.repeat(4)}`,
      );
      fs.writeFileSync(
        path.join(workspaceDir, BIG_FILE),
        [...half, MARKER, ...half].join('\n'),
        'utf8',
      );
    });

    When('I ask the agent to read that file with the shell', async () => {
      session!.send(
        `You MUST call the shell_exec tool exactly once, with command "cat ${BIG_FILE}" ` +
          'and limit 5000000 so nothing is dropped by the shell. Then reply with one short ' +
          'sentence. Do not call any other tool.',
      );
      await sleep(200);
      session!.send(KEYS.ENTER);
    });

    Then('the stored tool result is the capped view, not the raw payload', async () => {
      const call = await waitForToolCall(env.dbPath, 'shell_exec');

      expect(call.rendered).toBe(true);
      expect(call.truncated).toBeDefined();
      // The whole file is far bigger than what was stored.
      expect(call.truncated!.totalChars).toBeGreaterThan(200_000);
      expect(call.output.length).toBeLessThan(40_000);
      expect(call.output).toContain('[INCOMPLETE OUTPUT');
    });

    And('the whole output is saved on disk', async () => {
      const call = await waitForToolCall(env.dbPath, 'shell_exec');
      const spillId = call.truncated!.spillId!;
      expect(spillId).toBeTruthy();

      const saved = path.join(dataDir, 'tool-outputs', spillId);
      expect(fs.existsSync(saved)).toBe(true);
      // What was saved is the whole rendering the cut was taken from.
      expect(fs.readFileSync(saved, 'utf8').length).toBe(call.truncated!.totalChars);
      // …and it holds the part the model was not shown.
      expect(fs.readFileSync(saved, 'utf8')).toContain(MARKER);
      // The notice hands the agent the id, or it has no way back to any of this.
      expect(call.output).toContain(spillId);
    });

    And('the part it was not shown is absent from what it read', async () => {
      const call = await waitForToolCall(env.dbPath, 'shell_exec');
      expect(call.output).not.toContain(MARKER);
    });

    When('I ask the agent what the marker line says', async () => {
      session!.send(
        'That output was cut. Find the line containing MIDDLE-MARKER-4T7X in the saved ' +
          'output and tell me the whole line.',
      );
      await sleep(200);
      session!.send(KEYS.ENTER);
    });

    Then('it searches the saved output rather than re-reading it whole', async () => {
      const call = await waitForToolCall(env.dbPath, 'read_tool_output');
      expect(call.tool).toBe('read_tool_output');
      // A search, not a walk: nothing it read back was itself big enough to cut.
      expect(call.truncated).toBeUndefined();
    });

    And('it answers with the marker text', async () => {
      await session!.waitForFrame(/chartreuse/, 180_000);
    });
  });

  Scenario('A saved result is not re-sent on every later turn', ({ When, Then }) => {
    When('I ask the agent an unrelated question', async () => {
      session!.send('In one short sentence, what is the capital of France?');
      await sleep(200);
      session!.send(KEYS.ENTER);
      // Wait for the answer, not just for the send.
      await session!.waitForFrame(/Paris/i, 180_000);
    });

    Then("the conversation's context stays far below the size of the raw result", () => {
      const tokens = latestContextTokens(env.dbPath);
      expect(tokens).not.toBeNull();
      // The raw file is ~500,000 chars, roughly 120,000 tokens. If the stored
      // result were replayed raw — the defect this whole change exists to fix —
      // this turn alone would blow past this ceiling.
      expect(tokens!).toBeLessThan(60_000);
    });
  });
});
