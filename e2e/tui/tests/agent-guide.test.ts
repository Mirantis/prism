/**
 * E2E: editing the agent guide from the terminal UI.
 *
 * `/agent-guide` hands the document to `$EDITOR` and PATCHes what comes back,
 * so the editor here is a shell script that writes a known string — that keeps
 * the scenario deterministic while still exercising the real path: Ink releases
 * the terminal, a child process edits a temp file, and the CLI reads it back.
 *
 * The assertion is on `agent_workspaces.agentMd` in SQLite. The on-screen SYSTEM
 * line is asserted too, because "saved" and "unchanged" are the only signal the
 * user gets that their edit landed.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import Database from 'better-sqlite3';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/agent-guide.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
/** Temp dirs holding the scripted editors, removed after each scenario. */
const editorDirs: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readGuide(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT agentMd FROM agent_workspaces LIMIT 1').get() as
      | { agentMd: string | null }
      | undefined;
    return row?.agentMd ?? '';
  } finally {
    db.close();
  }
}

/** Quote `text` for a single-quoted shell string, refusing what would break it. */
function shellLiteral(text: string): string {
  if (text.includes("'")) throw new Error(`scenario text must not contain a quote: ${text}`);
  return `'${text}'`;
}

/** A stand-in for the user's editor: a shell script over the temp file in $1. */
function makeEditor(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prism-e2e-editor-'));
  editorDirs.push(dir);
  const file = join(dir, 'editor.sh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** Start the CLI with `EDITOR` pointed at `script`, then run `/agent-guide`. */
async function runAgentGuideWith(script: string): Promise<void> {
  session = startPrism({
    env: { ...env.prismEnv, EDITOR: script },
    runtime: env.runtime,
  });
  await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  // The trailing space closes the slash popup, so one Enter runs the command —
  // the Enter-completes path is covered by slash-commands.test.ts. Give Ink a
  // beat to commit the line before Enter, as the other command specs do.
  session.send('/agent-guide ');
  await sleep(300);
  session.send(KEYS.ENTER);
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
      while (editorDirs.length > 0) rmSync(editorDirs.pop()!, { recursive: true, force: true });
    });

    defineSteps(({ Step }) => {
      // Seeding and asserting are separate steps on purpose: one step that
      // wrote the expected value when it did not match would turn a lost save
      // into a pass.
      Step('the agent guide starts as {string}', async (_ctx, value: string) => {
        await runtimeRequest(env.port, 'PATCH', '/agents/agent-guide', { agentMd: value });
        expect(readGuide(env.dbPath)).toBe(value);
      });

      Step('the stored agent guide is {string}', async (_ctx, value: string) => {
        expect(readGuide(env.dbPath)).toBe(value);
      });

      Step(
        'I run "/agent-guide" with an editor that writes {string}',
        async (_ctx, text: string) => {
          await runAgentGuideWith(makeEditor(`printf '%s' ${shellLiteral(text)} > "$1"`));
        },
      );

      Step('I run "/agent-guide" with an editor that changes nothing', async () => {
        await runAgentGuideWith(makeEditor('exit 0'));
      });

      Step('I run "/agent-guide" with an editor that records its terminal mode', async () => {
        // `-icanon` in stty's output means the tty is still raw, i.e. the TUI
        // never let go of it.
        await runAgentGuideWith(
          makeEditor(
            'if stty -a 2>/dev/null | grep -q -- "-icanon"; then printf RAW_TTY > "$1"; ' +
              'else printf COOKED_TTY > "$1"; fi',
          ),
        );
      });

      Step('the CLI reports the guide was saved', async () => {
        await session!.waitForFrame(/Agent guide saved/, 60_000);
      });

      Step('the CLI reports the guide unchanged', async () => {
        await session!.waitForFrame(/Agent guide unchanged/, 60_000);
      });
    });

    Scenario('What the editor saved becomes the stored guide', () => {
      // Covered by the shared steps.
    });

    Scenario('An editor that saves nothing leaves the guide alone', () => {
      // Covered by the shared steps.
    });

    Scenario('The editor inherits a normal terminal', () => {
      // Covered by the shared steps.
    });
  },
);
