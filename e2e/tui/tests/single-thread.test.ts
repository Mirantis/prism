/**
 * `prism-cli` against a runtime in single-thread mode: every launch opens the
 * agent's one conversation with its history, `--resume` and `--continue` included, and no launch
 * creates a thread. No Bedrock interaction required.
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, type TuiSession } from '../harness';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

/**
 * Store one message in a thread, as an earlier turn would have. It copies the
 * thread's own createdAt, so the value reads back through Prisma whatever its
 * on-disk DateTime encoding.
 */
function seedMessage(dbPath: string, threadId: string, content: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, createdAt)
       SELECT ?, id, 'AGENT', ?, 'USER_INPUT', 0, createdAt
       FROM conversation_threads WHERE id = ?`,
    ).run(`msg-${content}`, content, threadId);
  } finally {
    db.close();
  }
}

function webThreadCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM conversation_threads WHERE externalThreadId IS NULL').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/single-thread.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession | undefined;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime({ runtimeEnvOverrides: { THREAD_MODE: 'single' } });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  AfterEachScenario(async () => {
    if (session) await session.stop();
    session = undefined;
  });

  const seedConversation = async (marker: string) => {
    const { threadId } = await runtimeRequest<{ threadId: string }>(env.port, 'GET', '/latest-thread');
    seedMessage(env.dbPath, threadId, marker);
  };

  Scenario('The CLI opens the conversation with its history', ({ Given, When, Then, And }) => {
    Given("the agent's conversation holds \"single-thread-history-marker\"", async () => {
      await seedConversation('single-thread-history-marker');
    });
    When('I launch the CLI', () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    });
    Then('the CLI shows "single-thread-history-marker"', async () => {
      await session!.waitForFrame(/single-thread-history-marker/, BOOT_FRAME_TIMEOUT_MS);
    });
    And('the agent still has one conversation', () => {
      expect(webThreadCount(env.dbPath)).toBe(1);
    });
  });

  Scenario('--resume opens the conversation without a picker', ({ Given, When, Then, And }) => {
    Given("the agent's conversation holds \"single-thread-resume-marker\"", async () => {
      await seedConversation('single-thread-resume-marker');
    });
    When('I launch the CLI with --resume', () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['--resume'] });
    });
    Then('the CLI shows "single-thread-resume-marker"', async () => {
      await session!.waitForFrame(/single-thread-resume-marker/, BOOT_FRAME_TIMEOUT_MS);
    });
    And('the CLI showed no resume picker', () => {
      expect(session!.output()).not.toMatch(/Resume session/);
    });
    And('the agent still has one conversation', () => {
      expect(webThreadCount(env.dbPath)).toBe(1);
    });
  });

  Scenario('--continue opens the conversation', ({ Given, When, Then, And }) => {
    Given("the agent's conversation holds \"single-thread-continue-marker\"", async () => {
      await seedConversation('single-thread-continue-marker');
    });
    When('I launch the CLI with --continue in another directory', () => {
      // The conversation did not start here: single-thread mode opens it anyway.
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['--continue'], cwd: os.tmpdir() });
    });
    Then('the CLI shows "single-thread-continue-marker"', async () => {
      await session!.waitForFrame(/single-thread-continue-marker/, BOOT_FRAME_TIMEOUT_MS);
    });
    And('the agent still has one conversation', () => {
      expect(webThreadCount(env.dbPath)).toBe(1);
    });
  });
});
