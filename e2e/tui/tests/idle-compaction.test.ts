/**
 * E2E: idle compaction, kept across a restart.
 *
 * The runtime runs under `CHAT_CACHE_TTL=1h`, where a chat conversation of at
 * least 200K tokens is compacted after 54 minutes idle. The test seeds such a
 * conversation and the `llm_calls` row of its last chat turn, dated so the
 * compaction is due a little after the CLI connects. The restart then has to
 * find it in the stored data, since no turn ran in this process.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, type TuiSession } from '../harness';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';
import {
  COMPACTION_TAIL_MESSAGES,
  IDLE_COMPACTION_CACHE_SHARE,
  IDLE_COMPACTION_MIN_TOKENS,
} from '../../../src/constants';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/idle-compaction.feature'), 'utf8'),
);

const SEED_COUNT = 10;
/** The seeded messages are short, so the row cap alone sets the tail. */
const TAIL = COMPACTION_TAIL_MESSAGES;
/** A Claude model, whose cache lasts an hour under `CHAT_CACHE_TTL=1h`. */
const CLAUDE_MODEL = 'global.anthropic.claude-opus-5-5';
const IDLE_DELAY_MS = IDLE_COMPACTION_CACHE_SHARE * 60 * 60 * 1000;
/**
 * How long after seeding the compaction is due. It covers the restart and the CLI's
 * boot on a slow runner, because the CLI shows only the event it is connected for.
 */
const DUE_IN_MS = 240_000;
/** The wait, then the summary, a real model call. */
const COMPACTION_TIMEOUT_MS = DUE_IN_MS + 180_000;

let env: RuntimeTestEnv;
let session: TuiSession | undefined;

const seededContent = (i: number) => `idle-seed-${i}: the nightly job writes to bucket backup-${100 + i}.`;

/** DateTime columns are epoch milliseconds (`timestampFormat: 'unixepoch-ms'` in `src/lib/prisma-adapter.ts`). */
function seedIdleConversation(dbPath: string, threadId: string): void {
  const now = Date.now();
  const db = new Database(dbPath);
  try {
    const { id: agentId } = db.prepare('SELECT id FROM agent_workspaces LIMIT 1').get() as { id: string };
    const insert = db.prepare(
      `INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, createdAt)
       VALUES (?, ?, ?, ?, 'USER_INPUT', 0, ?)`,
    );
    for (let i = 0; i < SEED_COUNT; i++) {
      insert.run(randomUUID(), threadId, i % 2 === 0 ? 'USER' : 'AGENT', seededContent(i), now - 2 * 60 * 60 * 1000 + i * 1000);
    }
    db.prepare('UPDATE conversation_threads SET contextTokens = ?, contextModel = ?, updatedAt = ? WHERE id = ?').run(
      IDLE_COMPACTION_MIN_TOKENS + 50_000,
      CLAUDE_MODEL,
      now,
      threadId,
    );
    db.prepare(
      `INSERT INTO llm_calls (id, agentId, purpose, model, threadId, createdAt) VALUES (?, ?, 'chat', ?, ?, ?)`,
    ).run(randomUUID(), agentId, CLAUDE_MODEL, threadId, now - IDLE_DELAY_MS + DUE_IN_MS);
  } finally {
    db.close();
  }
}

interface ThreadRow {
  compactionSummary: string | null;
}

function threadCompacted(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT compactedAt FROM conversation_threads').get() as { compactedAt: number | null }).compactedAt !== null;
  } finally {
    db.close();
  }
}

async function waitForCompaction(dbPath: string): Promise<void> {
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS;
  while (!threadCompacted(dbPath)) {
    if (Date.now() > deadline) throw new Error(`no compaction within ${COMPACTION_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function compactedContents(dbPath: string): { compacted: string[]; kept: number; thread: ThreadRow } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT content, isCompacted FROM conversation_messages ORDER BY createdAt')
      .all() as Array<{ content: string; isCompacted: number }>;
    const thread = db.prepare('SELECT compactionSummary FROM conversation_threads').get() as ThreadRow;
    return {
      compacted: rows.filter((r) => r.isCompacted).map((r) => r.content),
      kept: rows.filter((r) => !r.isCompacted).length,
      thread,
    };
  } finally {
    db.close();
  }
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime({ runtimeEnvOverrides: { THREAD_MODE: 'single', CHAT_CACHE_TTL: '1h' } });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  AfterEachScenario(async () => {
    await session?.stop();
    session = undefined;
  });

  Scenario('A runtime restart keeps an idle conversation\'s compaction scheduled', ({ Given, When, Then, And }) => {
    Given('a large conversation whose last chat turn ran almost 54 minutes ago', async () => {
      const { threadId } = await runtimeRequest<{ threadId: string }>(env.port, 'GET', '/latest-thread');
      seedIdleConversation(env.dbPath, threadId);
    });

    When('the runtime restarts', async () => {
      await env.restart();
    });

    And('I launch the CLI', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(new RegExp(`idle-seed-${SEED_COUNT - 1}`), BOOT_FRAME_TIMEOUT_MS);
      if (threadCompacted(env.dbPath)) {
        throw new Error(`the compaction ran before the CLI connected; raise DUE_IN_MS (${DUE_IN_MS}ms)`);
      }
    });

    Then('the CLI shows that the conversation was compacted while idle', async () => {
      await waitForCompaction(env.dbPath);
      await session!.waitForFrame(/Conversation compacted while idle/, 30_000);
    });

    And('the older messages are compacted while the newest stay', () => {
      const { compacted, kept, thread } = compactedContents(env.dbPath);
      expect(thread.compactionSummary).toMatch(/## Goal/);
      expect(compacted).toEqual(Array.from({ length: SEED_COUNT - TAIL }, (_, i) => seededContent(i)));
      expect(kept).toBe(TAIL);
    });
  });
});
