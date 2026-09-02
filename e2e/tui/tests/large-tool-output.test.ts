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
const FILLER_LINES = 1_800;
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
  input: string;
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

/** The snapshot lands in `finalize()`, just after the turn's last step. */
async function waitForContextTokens(dbPath: string, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tokens = latestContextTokens(dbPath);
    if (tokens !== null) return tokens;
    await sleep(1000);
  }
  throw new Error('no context snapshot was written');
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
    // The CLI sends its cwd as the thread's workspace root, and the shell tools
    // prefer that over SHELL_WORKSPACE_ROOT, so the file is read from here.
    session = startPrism({ env: env.prismEnv, runtime: env.runtime, cwd: workspaceDir });
    await session!.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session?.stop();
  });

  Scenario('The agent searches the part of a result it was never shown', ({ Given, When, Then, And }) => {
    Given("the agent's workspace holds a file too large to return whole", () => {
      resetThread(env.dbPath);

      // ~293 chars a line under `shell_read_file`'s 2000-char-per-line ceiling, and
      // 1,800 lines under its 2,000-line default — so the whole file comes back in
      // one call, well past the 30,000-char budget, with the marker at the exact
      // middle where a head+tail cut removes it.
      const half = Array.from({ length: FILLER_LINES / 2 }, (_, i) =>
        `line ${String(i).padStart(6, '0')}: ${'filler '.repeat(40)}`,
      );
      fs.writeFileSync(
        path.join(workspaceDir, BIG_FILE),
        [...half, MARKER, ...half].join('\n'),
        'utf8',
      );
    });

    When('I ask the agent to read that file', async () => {
      // `shell_read_file` rather than `shell_exec`: it returns up to 2000 lines by
      // default, so the result is over the cap without the model having to choose a
      // size argument. Depending on it passing `limit` made this test's whole
      // premise a coin flip, and the coin came up tails.
      session!.send(
        `You MUST call the shell_read_file tool exactly once, on the path ${BIG_FILE}, ` +
          'with no offset and no limit. Then reply with one short sentence. Do not call ' +
          'any other tool.',
      );
      await sleep(200);
      session!.send(KEYS.ENTER);
    });

    Then('the stored tool result is the capped view, not the raw payload', async () => {
      const call = await waitForToolCall(env.dbPath, 'shell_read_file');

      expect(call.rendered).toBe(true);
      expect(call.truncated).toBeDefined();
      // The whole file is far bigger than what was stored.
      expect(call.truncated!.totalChars).toBeGreaterThan(200_000);
      expect(call.output.length).toBeLessThan(40_000);
      expect(call.output).toContain('[INCOMPLETE OUTPUT');
    });

    And('the whole output is saved on disk', async () => {
      const call = await waitForToolCall(env.dbPath, 'shell_read_file');
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
      const call = await waitForToolCall(env.dbPath, 'shell_read_file');
      expect(call.output).not.toContain(MARKER);
    });

    When('I ask the agent what the marker line says', async () => {
      session!.send(
        'That output was cut. The notice gives the path of the saved copy — grep it ' +
          'for MIDDLE-MARKER-4T7X with the shell and tell me the whole line.',
      );
      await sleep(200);
      session!.send(KEYS.ENTER);
    });

    Then('it reads the saved file with the shell rather than fetching again', async () => {
      const read = await waitForToolCall(env.dbPath, 'shell_read_file');
      const spillId = read.truncated!.spillId!;

      const exec = await waitForToolCall(env.dbPath, 'shell_exec');
      // It went to the saved copy the notice named, not back to the file the cut was
      // taken from — which is the whole point of saving it.
      expect(exec.input).toContain(spillId);
      // A search, not a walk: what came back was small enough that nothing cut it.
      expect(exec.truncated).toBeUndefined();
    });

    And('it answers with the marker text', async () => {
      await session!.waitForFrame(/chartreuse/, 180_000);
    });

    When('I ask an unrelated question in the same conversation', async () => {
      // Same session, so the same thread — which is the point. A fresh CLI would
      // start a new thread and this assertion would pass without proving anything.
      session!.send('In one short sentence, what is the capital of France?');
      await sleep(200);
      session!.send(KEYS.ENTER);
      await session!.waitForFrame(/Paris/i, 180_000);
    });

    Then("the conversation's context stays far below the size of the raw result", async () => {
      const tokens = await waitForContextTokens(env.dbPath);

      // The result is ~540,000 chars, roughly 130,000 tokens. If the stored result
      // were replayed raw — the defect this whole change exists to fix — this turn
      // alone would blow past the ceiling.
      expect(tokens).toBeLessThan(60_000);
    });
  });
});
