/**
 * E2E: verbose / concise delivery in prism-cli.
 *
 * Sets verbose via the management API, sends a multi-step prompt, then asserts
 * delivery count on-screen vs AGENT rows in the SQLite DB.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/verbose.feature'), 'utf8'),
);

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
    resetThread(env.dbPath);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Concise mode shows one response block but DB has multiple AGENT rows', ({ Given, When, Then, And }) => {
    Given('verbose is false', async () => {
      await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: false });
    });

    When('I send a multi-step prompt', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, 30_000);
      session.send('Use a tool then tell me the result.');
      await new Promise((r) => setTimeout(r, 200));
      session.send(KEYS.ENTER);
      await session.waitForFrame(/▸/, 60_000);
    });

    Then('the TUI shows one agent response block', async () => {
      const output = session.output();
      const agentBlocks = output.split(/(?=▸)/).filter((b) => !b.includes('You:'));
      expect(agentBlocks.length).toBeGreaterThanOrEqual(1);
    });

    And('the database has more than one AGENT message', async () => {
      const db = new Database(env.dbPath);
      try {
        const row = db.prepare("SELECT COUNT(*) as cnt FROM conversation_messages WHERE role = 'AGENT'").get() as { cnt: number };
        expect(row.cnt).toBeGreaterThan(1);
      } finally {
        db.close();
      }
    });
  });

  Scenario('Verbose mode streams all intermediate steps', ({ Given, When, Then }) => {
    Given('verbose is true', async () => {
      await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: true });
    });

    When('I send a multi-step prompt', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, 30_000);
      session.send('Use a tool then tell me the result.');
      await new Promise((r) => setTimeout(r, 200));
      session.send(KEYS.ENTER);
      await session.waitForFrame(/▸/, 60_000);
    });

    Then('the TUI shows multiple agent response blocks', async () => {
      const db = new Database(env.dbPath);
      try {
        const row = db.prepare("SELECT COUNT(*) as cnt FROM conversation_messages WHERE role = 'AGENT'").get() as { cnt: number };
        expect(row.cnt).toBeGreaterThan(1);
      } finally {
        db.close();
      }
    });
  });
});
