/**
 * E2E: `! <command>` in the composer.
 *
 * The command runs under the PTY the harness gives the CLI, which is the real
 * hand-over: Ink releases the terminal, `script` records the command, and the
 * record goes to the runtime as the user's message, which starts a turn.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import {
  setupRuntime,
  resetThread,
  waitForMessageCount,
  waitForStoredMessage,
  type RuntimeTestEnv,
} from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/shell-command.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function userMessages(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT content FROM conversation_messages WHERE role = 'USER' ORDER BY createdAt")
      .all() as { content: string }[];
    return rows.map((r) => r.content);
  } finally {
    db.close();
  }
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
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('The command runs in the terminal and the agent receives its output', ({ When, Then, And }) => {
    When('I run {string} from the composer', async (_ctx, line: string) => {
      session.send(line);
      // Let the composer commit the typed line before Enter.
      await sleep(300);
      session.send(KEYS.ENTER);
    });
    Then('the chat shows the command with exit code 3', async () => {
      await session.waitForFrame(/exit code 3/, 30_000);
    });
    And(
      'the stored user message records the command, exit code 3 and the output {string}',
      async (_ctx, output: string) => {
        await waitForStoredMessage(env.dbPath, 'USER', '<user-shell-command>', 30_000);
        expect(userMessages(env.dbPath)).toEqual([
          [
            '<user-shell-command>',
            `<command>echo ${output}; exit 3</command>`,
            '<exit-code>3</exit-code>',
            '<output>',
            output,
            '</output>',
            '</user-shell-command>',
          ].join('\n'),
        ]);
      },
    );
    And('the agent replies', async () => {
      await waitForMessageCount(env.dbPath, 'AGENT', 1, 300_000);
    });
  });
});
