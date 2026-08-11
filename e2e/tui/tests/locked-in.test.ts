/**
 * E2E: locked-in mode from the terminal UI.
 *
 * Locked-in mode has no TUI-specific control — the switch lives in the web
 * Profile page — so what the TUI proves is the part that is transport-agnostic:
 * the runtime's `PATCH /agents/locked-in` round-trip, and that a real chat turn
 * driven from `prism-cli` cannot write a locked workspace document.
 *
 * The assertion reads `agent_workspaces.soulMd` out of SQLite rather than
 * matching the reply on screen. The lock's guarantee is about stored state, and
 * how the model phrases "I can't do that" is not a contract — the unlocked
 * control scenario is what shows the frozen result isn't just a reluctant model.
 *
 * The repeated "I ask the agent to rewrite its soul" / "locked-in is …" steps go
 * through `defineSteps` because vitest-cucumber requires a shared registration
 * for a step used by more than one Scenario.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/locked-in.feature'), 'utf8'),
);

// Sentinel the model is asked to put in the soul document, so "changed" is a
// specific claim rather than any diff at all.
const SOUL_MARKER = 'PIRATEMODE7K';

const REWRITE_PROMPT =
  `Use your update_soul tool to append the line ${SOUL_MARKER} to your soul document. ` +
  'Then tell me whether it worked.';

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
/** Soul text captured before the turn, so unchanged/changed is a real comparison. */
let soulBefore = '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readSoul(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT soulMd FROM agent_workspaces LIMIT 1').get() as
      | { soulMd: string | null }
      | undefined;
    return row?.soulMd ?? '';
  } finally {
    db.close();
  }
}

function readLockedIn(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT lockedIn FROM agent_workspaces LIMIT 1').get() as
      | { lockedIn: number | null }
      | undefined;
    return Boolean(row?.lockedIn);
  } finally {
    db.close();
  }
}

/** Poll SQLite until the soul document differs from `soulBefore`. */
async function waitForSoulChange(dbPath: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const soul = readSoul(dbPath);
    if (soul !== soulBefore) return soul;
    await sleep(500);
  }
  throw new Error(`Soul document never changed within ${timeoutMs}ms (still ${JSON.stringify(soulBefore)})`);
}

describeFeature(
  feature,
  ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario, defineSteps }) => {
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
      // Leave the lock off so a failed scenario can't strand the next one.
      await runtimeRequest(env.port, 'PATCH', '/agents/locked-in', { lockedIn: false });
    });

    defineSteps(({ Step }) => {
      Step('I set locked-in to {string}', async (_ctx, value: string) => {
        await runtimeRequest(env.port, 'PATCH', '/agents/locked-in', { lockedIn: value === 'true' });
      });

      Step('the stored locked-in flag is {string}', async (_ctx, value: string) => {
        expect(readLockedIn(env.dbPath)).toBe(value === 'true');
      });

      Step('locked-in is {string}', async (_ctx, value: string) => {
        await runtimeRequest(env.port, 'PATCH', '/agents/locked-in', { lockedIn: value === 'true' });
        soulBefore = readSoul(env.dbPath);
        expect(soulBefore, 'the seeded agent should have a soul document to protect').not.toBe('');
      });

      Step('I ask the agent to rewrite its soul', async () => {
        session = startPrism({ env: env.prismEnv, runtime: env.runtime });
        await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
        session.send(REWRITE_PROMPT);
        await sleep(200);
        session.send(KEYS.ENTER);
        // The turn reached the model and came back: enough for the tool call to
        // have been attempted (and refused, or applied).
        await session.waitForFrame(/▌\s+Prism\b/, 120_000);
      });

      Step('the soul document is unchanged', async () => {
        // Give a write that WAS going to land time to land, so this isn't
        // just measuring that the assertion ran first.
        await sleep(3_000);
        expect(readSoul(env.dbPath)).toBe(soulBefore);
        expect(readSoul(env.dbPath)).not.toContain(SOUL_MARKER);
      });

      Step('the soul document has changed', async () => {
        const soul = await waitForSoulChange(env.dbPath);
        expect(soul).toContain(SOUL_MARKER);
      });
    });

    Scenario('The lock round-trips through the REST API', () => {
      // Covered by the shared steps.
    });

    Scenario('A locked agent leaves its soul document alone', () => {
      // Covered by the shared steps.
    });

    Scenario('An unlocked agent rewrites its soul document', () => {
      // Covered by the shared steps.
    });
  },
);
