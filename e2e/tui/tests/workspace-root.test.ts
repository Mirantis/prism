/**
 * Workspace root is the CLI's cwd.
 *
 * The CLI sends `process.cwd()` as the new thread's workspaceRoot when it opens
 * (see tui-adapter `startNewSession`). The harness spawns prism-cli with its
 * cwd set to the cli/ package dir (PRISM_CLI_DIR), so the runtime must persist
 * exactly that path on the freshly created thread. We assert against the real
 * (symlink-resolved) path because `process.cwd()` returns the canonical form.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, PRISM_CLI_DIR, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/workspace-root.feature'), 'utf8'),
);

/** Latest (non-Slack) database thread's persisted workspace root. */
function latestThreadWorkspaceRoot(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 2000');
  try {
    const row = db
      .prepare(
        "SELECT workspaceRoot FROM conversation_threads " +
          'WHERE externalThreadId IS NULL ' +
          'ORDER BY createdAt DESC LIMIT 1',
      )
      .get() as { workspaceRoot: string | null } | undefined;
    return row?.workspaceRoot ?? null;
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let env: RuntimeTestEnv;
let session: TuiSession;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    // Default cwd is PRISM_CLI_DIR (the cli/ package), which becomes the CLI's
    // process.cwd() and thus the new thread's workspaceRoot.
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario("The new thread's workspace root is the CLI's working directory", ({ Then }) => {
    Then("the latest thread's workspace root equals the CLI working directory", async () => {
      const expected = realpathSync(PRISM_CLI_DIR);

      // startNewSession() POSTs /threads on mount asynchronously;
      // poll the DB until the new thread (carrying its workspaceRoot) lands.
      let root: string | null = null;
      for (let i = 0; i < 60 && root !== expected; i++) {
        root = latestThreadWorkspaceRoot(env.dbPath);
        if (root !== expected) await sleep(250);
      }

      expect(root).toBe(expected);
    });
  });
});
