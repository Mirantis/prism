/**
 * E2E: the remaining-context indicator in the prism-cli status bar.
 *
 * Terminal assertions here are deliberately **presence-only**. `session.output()`
 * is the whole accumulated PTY stream and the status bar is not an Ink `<Static>`,
 * so every re-render appends another copy of the bar — counting occurrences, or
 * asserting a single exact percentage, is meaningless. A regex match for the
 * shape is the strongest safe terminal claim.
 *
 * The precise numbers are asserted against authoritative state instead: the
 * `conversation_threads` row the runtime wrote, and the `GET /threads` payload the
 * `--resume` picker consumes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/context-window.feature'), 'utf8'),
);

/** Appended by the model to its final message so we can detect turn completion. */
const DONE_SENTINEL = 'CTXDONE7Q';
const PROMPT = `Reply with one short sentence ending in the token ${DONE_SENTINEL}.`;

/** Matches "| context 58%" anywhere in the accumulated stream. */
const CONTEXT_PATTERN = /context \d+%/;

/**
 * Waits for a CLI to render its first frame. Deliberately generous: this suite's
 * dominant flake is the boot frame never arriving under CI load — it has blown a
 * 90s budget in share-file.test.ts — and a stalled boot fails the scenario with a
 * timeout that says nothing about the feature. Matches the budget attach.test.ts
 * and chat.test.ts already use. It costs nothing on a healthy run, because
 * waitForFrame returns the moment the frame matches.
 */
const BOOT_TIMEOUT_MS = 120_000;

let env: RuntimeTestEnv;
let session: TuiSession | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ThreadContextRow {
  id: string;
  contextTokens: number | null;
  contextModel: string | null;
}

function latestThreadRow(dbPath: string): ThreadContextRow | undefined {
  const db = new Database(dbPath);
  try {
    return db
      .prepare(
        'SELECT id, contextTokens, contextModel FROM conversation_threads ORDER BY updatedAt DESC LIMIT 1',
      )
      .get() as ThreadContextRow | undefined;
  } finally {
    db.close();
  }
}

function finalMessagePersisted(dbPath: string): boolean {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE role = 'AGENT' AND content LIKE ?")
      .get(`%${DONE_SENTINEL}%`) as { n: number };
    return row.n > 0;
  } finally {
    db.close();
  }
}

/**
 * Wait until the turn's final message is persisted AND the context snapshot has
 * been written. The snapshot lands in `finalize()`, just after the last step, so
 * the message alone is not proof the column is populated yet.
 */
async function waitForSnapshot(dbPath: string, timeoutMs = 120_000): Promise<ThreadContextRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (finalMessagePersisted(dbPath)) {
      const row = latestThreadRow(dbPath);
      if (row?.contextTokens != null && row.contextModel != null) return row;
    }
    await sleep(500);
  }
  throw new Error(
    `context snapshot not written within ${timeoutMs}ms; last row: ${JSON.stringify(latestThreadRow(dbPath))}`,
  );
}

async function runOneTurn(): Promise<void> {
  session!.send(PROMPT);
  await sleep(200);
  session!.send(KEYS.ENTER);
  await waitForSnapshot(env.dbPath);
  // Give the CLI a beat to receive the context frame and repaint the status bar.
  await session!.waitForFrame(CONTEXT_PATTERN, 30_000);
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    resetThread(env.dbPath);
  });
  AfterEachScenario(async () => {
    await session?.stop();
    session = undefined;
  });

  Scenario('The status bar shows context used after a turn', ({ Given, When, Then, And }) => {
    Given('a fresh CLI session', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, BOOT_TIMEOUT_MS);
    });

    Then('the status bar shows no context percentage yet', async () => {
      // Nothing has been measured, so the runtime sends no reading at all — the
      // bar must not invent a reassuring "0%".
      expect(session!.output()).not.toMatch(CONTEXT_PATTERN);
    });

    When('I send a message and the turn completes', async () => {
      await runOneTurn();
    });

    Then('the status bar shows a context percentage', async () => {
      expect(session!.output()).toMatch(CONTEXT_PATTERN);
    });

    And("the thread's context snapshot is recorded in the database", async () => {
      const row = latestThreadRow(env.dbPath)!;
      // A real measurement: the system prompt and tool definitions alone put this
      // well above zero.
      expect(row.contextTokens).toBeGreaterThan(0);
      expect(row.contextModel).toBeTruthy();
    });

    And('the threads endpoint reports the same snapshot', async () => {
      const row = latestThreadRow(env.dbPath)!;
      const threads = await runtimeRequest<
        { id: string; contextUsage: { usedTokens: number; windowTokens: number; usedPercent: number } | null }[]
      >(env.port, 'GET', '/threads');

      const summary = threads.find((t) => t.id === row.id);
      expect(summary, 'the resumed-session picker must see this thread').toBeTruthy();
      expect(summary!.contextUsage).not.toBeNull();
      expect(summary!.contextUsage!.usedTokens).toBe(row.contextTokens);

      // The percentage the picker hands the status bar must be derived from the
      // stored tokens, not invented — recompute it here. Note the API reports
      // *consumption*; the status bar renders the complement.
      const { usedTokens, windowTokens, usedPercent } = summary!.contextUsage!;
      expect(windowTokens).toBeGreaterThan(0);
      expect(usedPercent).toBe(
        Math.min(100, Math.max(0, Math.round((100 * usedTokens) / windowTokens))),
      );
    });
  });

  Scenario('A resumed session shows the last known percentage', ({ Given, When, Then, And }) => {
    Given('a fresh CLI session', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, BOOT_TIMEOUT_MS);
    });

    When('I send a message and the turn completes', async () => {
      await runOneTurn();
    });

    And('I resume the session in a new CLI', async () => {
      // A fresh CLI has no live frame to rely on, so the reading can only come
      // from the stored snapshot travelling through GET /threads.
      await session?.stop();
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['--resume'] });
      await session.waitForFrame(/Resume session/, BOOT_TIMEOUT_MS);
      session.send(KEYS.ENTER); // newest thread (the turn just run) is row 1
      await session.waitForFrame(/▌\s+Prism\b/, BOOT_TIMEOUT_MS);
      await sleep(1_000);
    });

    Then('the status bar shows a context percentage', async () => {
      expect(session!.output()).toMatch(CONTEXT_PATTERN);
    });
  });
});
