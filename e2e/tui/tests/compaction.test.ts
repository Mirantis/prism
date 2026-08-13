/**
 * E2E: automatic conversation compaction, forced deterministically.
 *
 * The runtime is booted with `CONTEXT_WINDOW_TOKENS=5000` — above the
 * MIN_PLAUSIBLE_CONTEXT floor (1000), but far below what the system prompt and
 * tool definitions alone consume — so every measured turn reads ≥90% and the
 * auto-compaction trigger fires as soon as there is anything to compact.
 * `COMPACTION_TAIL_MESSAGES=1` makes that happen on the second turn: the first
 * turn's context holds only the just-stored user message (1 row ≤ tail), the
 * second turn's context holds the first exchange plus the new message.
 *
 * Assertions are DB-authoritative (summary column, isCompacted flags); the
 * terminal claim is presence-only, matching the suite's conventions — the
 * persistent "Conversation compacted" system line, not the transient spinner
 * label, which can repaint away between polls.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/compaction.feature'), 'utf8'),
);

const DONE_SENTINEL = 'CMPDONE7Q';
const PROMPT = `Reply with one short sentence ending in the token ${DONE_SENTINEL}.`;
/** The summarize call is a real model call queued behind the turn — allow for it. */
const COMPACTION_TIMEOUT_MS = 180_000;

let env: RuntimeTestEnv;
let session: TuiSession | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CompactionRow {
  compactionSummary: string | null;
  compactedThroughTs: string | null;
}

function latestThreadCompaction(dbPath: string): CompactionRow | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        'SELECT compactionSummary, compactedThroughTs FROM conversation_threads ORDER BY updatedAt DESC LIMIT 1',
      )
      .get() as CompactionRow | undefined;
  } finally {
    db.close();
  }
}

function countRows(dbPath: string, where: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE ${where}`)
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Wait for the sentinel to be persisted `times` times (one per completed turn). */
async function waitForReplies(dbPath: string, times: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = countRows(dbPath, `role = 'AGENT' AND content LIKE '%${DONE_SENTINEL}%'`);
    if (n >= times) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${n}/${times} sentinel replies persisted after ${timeoutMs}ms`);
    }
    await sleep(500);
  }
}

async function waitForCompaction(dbPath: string): Promise<CompactionRow> {
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS;
  for (;;) {
    const row = latestThreadCompaction(dbPath);
    if (row?.compactionSummary) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `no compaction summary written within ${COMPACTION_TIMEOUT_MS}ms; row: ${JSON.stringify(row)}`,
      );
    }
    await sleep(1_000);
  }
}

async function sendPrompt(): Promise<void> {
  session!.send(PROMPT);
  await sleep(300);
  session!.send(KEYS.ENTER);
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime({
      runtimeEnvOverrides: {
        CONTEXT_WINDOW_TOKENS: '5000',
        COMPACTION_TAIL_MESSAGES: '1',
      },
    });
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

  Scenario('A full context window triggers compaction after a turn', ({ Given, When, Then, And }) => {
    Given('a fresh CLI session against a tiny context window', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
    });

    When('I send a message and the turn completes', async () => {
      await sendPrompt();
      await waitForReplies(env.dbPath, 1);
    });

    And('I send a second message and the turn completes', async () => {
      await sendPrompt();
      await waitForReplies(env.dbPath, 2);
    });

    Then('the thread gains a compaction summary in the database', async () => {
      const row = await waitForCompaction(env.dbPath);
      // The structured template's fixed headings prove a real summary landed,
      // not an error string.
      expect(row.compactionSummary).toMatch(/## Goal/);
      expect(row.compactedThroughTs).toBeTruthy();
    });

    And('older messages are marked compacted while the tail survives', async () => {
      const compacted = countRows(env.dbPath, 'isCompacted = 1');
      const remaining = countRows(env.dbPath, 'isCompacted = 0');
      expect(compacted).toBeGreaterThanOrEqual(1);
      // COMPACTION_TAIL_MESSAGES=1 — at least the newest message stays verbatim.
      expect(remaining).toBeGreaterThanOrEqual(1);
    });

    And('the CLI shows the compaction note', async () => {
      await session!.waitForFrame(/Conversation compacted/, 30_000);
    });
  });
});
