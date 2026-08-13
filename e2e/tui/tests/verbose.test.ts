/**
 * E2E: verbose / concise delivery in prism-cli.
 *
 * The concise/verbose distinction is purely a *delivery* decision — persistence
 * is byte-for-byte identical in both modes (every text step is stored as its own
 * AGENT row). So a DB row count can prove persistence but can NOT distinguish the
 * two modes. The authoritative signal is what reaches the channel, i.e. what the
 * TUI renders.
 *
 * We can't reliably *count* rendered bubbles: `session.output()` is the whole
 * accumulated PTY stream and the message list isn't an Ink <Static>, so a single
 * delivered bubble's `▌ Prism` prefix repeats across every re-render. Instead we
 * key off the *intermediate narration*: read the first (intermediate) AGENT row
 * the model actually produced from the DB, then assert its text is ABSENT from
 * the terminal in concise mode and PRESENT in verbose mode. Presence/absence is
 * immune to re-render duplication, and using the real persisted text avoids
 * guessing what the model said.
 *
 * The multi-step prompt asks the model to narrate before a tool call and finish
 * with a sentinel token; we poll the DB for the sentinel to know the turn is done.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/verbose.feature'), 'utf8'),
);

// Sentinel the model appends to its FINAL message; unlikely to appear in
// intermediate narration, so its arrival in the DB marks the turn complete.
const DONE_SENTINEL = 'TURNDONE9F';

// Coerces a two-text-step turn: a narration text step, a tool call, then a
// final text step. That guarantees at least one *intermediate* AGENT row whose
// delivery we can probe.
const MULTI_STEP_PROMPT =
  'First, tell me in one short sentence that you are about to run a command. ' +
  'Then use your shell to run `echo prism-echo-marker`. ' +
  `Then send a separate, final message telling me what it printed, ending with the token ${DONE_SENTINEL}.`;

let env: RuntimeTestEnv;
let session: TuiSession | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Persisted AGENT message contents in insertion order (rowid is monotonic). */
function agentRows(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT content FROM conversation_messages WHERE role = 'AGENT' ORDER BY rowid ASC")
      .all() as { content: string }[];
    return rows.map((r) => r.content);
  } finally {
    db.close();
  }
}

/** Poll the DB until the final message (carrying the sentinel) is persisted. */
async function waitForTurnComplete(dbPath: string, timeoutMs = 120_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = agentRows(dbPath);
    if (rows.some((r) => r.includes(DONE_SENTINEL))) return rows;
    await sleep(500);
  }
  throw new Error(
    `Final message with "${DONE_SENTINEL}" not persisted within ${timeoutMs}ms. ` +
      `AGENT rows: ${JSON.stringify(agentRows(dbPath))}`,
  );
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A short word-run from the intermediate narration that is distinctive enough to
 * probe for on screen: long enough to be unambiguous, and not already present in
 * the prompt (echoed in the user bubble) or the final message (always delivered).
 * Word-level so it survives terminal word-wrapping after whitespace normalization.
 */
function distinctivePhrase(intermediate: string, avoid: string[]): string | null {
  const avoidN = avoid.map(normalize);
  const words = intermediate.trim().split(/\s+/);
  for (let i = 0; i + 4 <= words.length; i++) {
    const phrase = words.slice(i, i + 4).join(' ');
    const p = normalize(phrase);
    if (p.length >= 12 && !avoidN.some((a) => a.includes(p))) return phrase;
  }
  const whole = normalize(intermediate);
  return whole.length >= 12 && !avoidN.some((a) => a.includes(whole)) ? intermediate.trim() : null;
}

/** Run one multi-step turn and return { rows, phrase } for the assertions. */
async function runMultiStepTurn(): Promise<{ rows: string[]; phrase: string }> {
  session = startPrism({ env: env.prismEnv, runtime: env.runtime });
  await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  session.send(MULTI_STEP_PROMPT);
  await sleep(200);
  session.send(KEYS.ENTER);

  const rows = await waitForTurnComplete(env.dbPath);
  // Let the CLI flush the delivered bubble(s) it received over the WS channel.
  await session.waitForFrame(/▌\s+Prism\b/, 30_000);
  await sleep(1_500);

  expect(rows.length, 'multi-step prompt should persist an intermediate + a final AGENT row').toBeGreaterThan(1);
  const intermediate = rows[0]!;
  const final = rows[rows.length - 1]!;
  const phrase = distinctivePhrase(intermediate, [MULTI_STEP_PROMPT, final]);
  expect(phrase, `no distinctive intermediate phrase found in: ${JSON.stringify(intermediate)}`).not.toBeNull();
  return { rows, phrase: phrase! };
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

  Scenario('Concise mode delivers only the final message but persists every step', ({ Given, When, Then, And }) => {
    let phrase = '';

    Given('verbose is false', async () => {
      await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: false });
    });

    When('I send a multi-step prompt', async () => {
      ({ phrase } = await runMultiStepTurn());
    });

    Then('the intermediate narration is not shown in the TUI', async () => {
      const out = normalize(session!.output());
      expect(out, `intermediate narration "${phrase}" should NOT be delivered in concise mode`).not.toContain(
        normalize(phrase),
      );
    });

    And('the database has more than one AGENT message', async () => {
      expect(agentRows(env.dbPath).length).toBeGreaterThan(1);
    });
  });

  Scenario('Concise mode keeps intermediate steps hidden after --resume', ({ Given, When, Then, And }) => {
    let phrase = '';

    Given('verbose is false', async () => {
      await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: false });
    });

    When('I send a multi-step prompt', async () => {
      ({ phrase } = await runMultiStepTurn());
    });

    And('I resume the session in a new CLI', async () => {
      // The live session never rendered the intermediate (concise). Resuming in a
      // fresh CLI reads history from the DB via GET /messages, which must also
      // hide the internal steps.
      await session?.stop();
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['--resume'] });
      await session.waitForFrame(/Resume session/, BOOT_FRAME_TIMEOUT_MS);
      session.send(KEYS.ENTER); // newest thread (the turn we just ran) is row 1
      // History has replayed once the agent reply prefix appears.
      await session.waitForFrame(/▌\s+Prism\b/, 30_000);
      await sleep(1_000);
    });

    Then('the intermediate narration is not shown after resume', async () => {
      const out = normalize(session!.output());
      expect(out, `intermediate narration "${phrase}" must stay hidden after --resume`).not.toContain(
        normalize(phrase),
      );
    });
  });

  Scenario('Verbose mode delivers the intermediate narration too', ({ Given, When, Then, And }) => {
    let phrase = '';

    Given('verbose is true', async () => {
      await runtimeRequest(env.port, 'PATCH', '/agents/verbose', { verbose: true });
    });

    When('I send a multi-step prompt', async () => {
      ({ phrase } = await runMultiStepTurn());
    });

    Then('the intermediate narration is shown in the TUI', async () => {
      const out = normalize(session!.output());
      expect(out, `intermediate narration "${phrase}" should be delivered in verbose mode`).toContain(
        normalize(phrase),
      );
    });

    And('the database has more than one AGENT message', async () => {
      expect(agentRows(env.dbPath).length).toBeGreaterThan(1);
    });
  });
});
