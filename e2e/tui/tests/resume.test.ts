/**
 * `prism-cli --resume` flow. Exercises the thread picker against a running
 * agent-runtime: listing prior threads (with git-branch labels), resuming a
 * selected thread (asserted authoritatively by its replayed history, plus that
 * the latest-thread pointer is left untouched — resuming pins by id, it does
 * NOT bump createdAt), Escape to exit, and the empty-state message. No Bedrock
 * interaction required.
 *
 * Written with @amiceli/vitest-cucumber; the Gherkin scenarios live in
 * features/resume.feature.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

const GIT_BRANCH = 'e2e-resume-branch';
// Distinctive history text seeded into the resumable thread so the test can
// assert the CLI replayed *that* thread after selecting it.
const RESUMED_MARKER = 'resumed-history-marker';

/** Wipe all threads + messages so each scenario starts from a known state. */
function wipeThreads(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('DELETE FROM conversation_messages; DELETE FROM conversation_threads;');
  } finally {
    db.close();
  }
}

/**
 * Seed one message into a thread by direct SQLite insert. Copies the thread's
 * own createdAt verbatim so the value round-trips through Prisma regardless of
 * its on-disk DateTime encoding — no Bedrock / no chat turn required.
 */
function seedMessage(dbPath: string, threadId: string, content: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, createdAt)
       SELECT ?, id, 'AGENT', ?, 'USER_INPUT', 0, createdAt
       FROM conversation_threads WHERE id = ?`,
    ).run(`msg-${threadId}`, content, threadId);
  } finally {
    db.close();
  }
}

/** A temp git work tree on a known branch, for the workspace-label assertion. */
function makeGitRepo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-resume-repo-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', branch], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Create a thread via the runtime (correct agent/owner) rooted at a dir. */
async function seedThread(port: number, workspaceRoot: string): Promise<string> {
  const { threadId } = await runtimeRequest<{ threadId: string }>(
    port,
    'POST',
    '/threads',
    { workspaceRoot },
  );
  return threadId;
}

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/resume.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
let gitRepoDir: string;
let plainDir: string;
// Set by the seeding steps. olderThreadId is the git-repo thread (created
// first → older → listed second); newerThreadId is the plain-dir thread.
let olderThreadId: string;
let newerThreadId: string;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
    gitRepoDir = makeGitRepo(GIT_BRANCH);
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-resume-plain-'));
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    fs.rmSync(gitRepoDir, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  });
  BeforeEachScenario(() => {
    wipeThreads(env.dbPath);
    session = undefined;
  });
  AfterEachScenario(async () => {
    if (session) await session.stop();
  });

  const launchResume = () => {
    session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['--resume'] });
  };

  Scenario('The picker lists prior sessions with their workspace', ({ Given, When, Then, And }) => {
    Given('two prior conversation threads exist', async () => {
      olderThreadId = await seedThread(env.port, gitRepoDir);
      newerThreadId = await seedThread(env.port, plainDir);
    });
    When('I launch the CLI with --resume', () => {
      launchResume();
    });
    Then('the resume picker lists both sessions', async () => {
      await session!.waitForFrame(/Resume session \(1 of 2\)/, 30_000);
      const out = session!.output();
      expect(out).toContain(olderThreadId);
      expect(out).toContain(newerThreadId);
    });
    And('a session is labelled with its git branch', async () => {
      await session!.waitForFrame(new RegExp(`\\(${GIT_BRANCH}\\)`), 10_000);
    });
  });

  Scenario('Selecting a session resumes that thread', ({ Given, When, Then, And }) => {
    Given('two prior conversation threads exist', async () => {
      olderThreadId = await seedThread(env.port, gitRepoDir);
      newerThreadId = await seedThread(env.port, plainDir);
      // Give the older (row 2) thread visible history so resuming it is provable.
      seedMessage(env.dbPath, olderThreadId, RESUMED_MARKER);
    });
    When('I launch the CLI with --resume', () => {
      launchResume();
    });
    And('I move down and select the older session', async () => {
      // Newest first: the plain-dir thread is row 1, the older git thread row 2.
      await session!.waitForFrame(/Resume session \(1 of 2\)/, 30_000);
      session!.send(KEYS.DOWN);
      await session!.waitForFrame(/Resume session \(2 of 2\)/, 5_000);
      session!.send(KEYS.ENTER);
    });
    Then('that thread becomes the active conversation', async () => {
      // The CLI replays the *selected* thread's history into the chat surface.
      await session!.waitForFrame(new RegExp(RESUMED_MARKER), 30_000);
      // Resuming pins by thread id — it must NOT bump createdAt, so the
      // latest-thread pointer is still the newer (unselected) thread.
      const { threadId } = await runtimeRequest<{ threadId: string }>(
        env.port,
        'GET',
        '/latest-thread',
      );
      expect(threadId).toBe(newerThreadId);
    });
  });

  Scenario('Escape leaves the picker and exits cleanly', ({ Given, When, Then, And }) => {
    Given('a prior conversation thread exists', async () => {
      olderThreadId = await seedThread(env.port, plainDir);
    });
    When('I launch the CLI with --resume', () => {
      launchResume();
    });
    And('I press Escape in the picker', async () => {
      await session!.waitForFrame(/Resume session/, 30_000);
      session!.send(KEYS.ESC);
    });
    Then('the CLI shuts down with exit code 0', async () => {
      const code = await session!.waitForExit(30_000);
      expect(code).toBe(0);
    });
  });

  Scenario('Nothing to resume exits with a message', ({ Given, When, Then, And }) => {
    Given('no prior conversation threads exist', () => {
      // BeforeEachScenario already wiped every thread.
    });
    When('I launch the CLI with --resume', () => {
      launchResume();
    });
    Then('the CLI reports there are no sessions to resume', async () => {
      await session!.waitForFrame(/No sessions to resume\./, 15_000);
    });
    And('the CLI shuts down with exit code 0', async () => {
      const code = await session!.waitForExit(30_000);
      expect(code).toBe(0);
    });
  });
});
