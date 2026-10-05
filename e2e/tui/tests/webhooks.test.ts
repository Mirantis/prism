/**
 * E2E: the /webhooks panel driven through the real PTY.
 *
 * Subscriptions are seeded and read back through the runtime's REST API. The
 * editor is a shell script that writes a known prompt, which keeps the hand-off
 * deterministic while still running the real path: the panel stays mounted,
 * Ink releases the terminal, and the form reads the edited file back.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/webhooks.feature'), 'utf8'),
);

interface StoredSubscription {
  id: string;
  name: string;
  description: string | null;
  prompt: string | null;
  isActive: boolean;
}

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
/** Temp dirs holding the scripted editors, removed after each scenario. */
const editorDirs: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Quote `text` for a single-quoted shell string, refusing what would break it. */
function shellLiteral(text: string): string {
  if (text.includes("'")) throw new Error(`scenario text must not contain a quote: ${text}`);
  return `'${text}'`;
}

/** A stand-in for the user's editor: a shell script that writes `text` to the file in $1. */
function makeEditor(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prism-e2e-editor-'));
  editorDirs.push(dir);
  const file = join(dir, 'editor.sh');
  writeFileSync(file, `#!/bin/sh\nprintf '%s' ${shellLiteral(text)} > "$1"\n`, { mode: 0o755 });
  return file;
}

async function listSubscriptions(): Promise<StoredSubscription[]> {
  return runtimeRequest<StoredSubscription[]>(env.port, 'GET', '/agents/webhook-subscriptions');
}

async function storedSubscription(name: string): Promise<StoredSubscription | undefined> {
  return (await listSubscriptions()).find((s) => s.name === name);
}

/** Start the CLI, optionally with `EDITOR` set, and open the panel. */
async function openPanel(editor?: string): Promise<void> {
  session = startPrism({
    env: editor ? { ...env.prismEnv, EDITOR: editor } : env.prismEnv,
    runtime: env.runtime,
  });
  await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  // The trailing space closes the slash popup, so one Enter runs the command.
  session.send('/webhooks ');
  await sleep(300);
  session.send(KEYS.ENTER);
  await session.waitForFrame('DELIVER TO', 10_000);
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
      for (const s of await listSubscriptions()) {
        await runtimeRequest(env.port, 'DELETE', `/agents/webhook-subscriptions/${s.id}`);
      }
    });
    AfterEachScenario(async () => {
      await session?.stop();
      session = undefined;
      while (editorDirs.length > 0) rmSync(editorDirs.pop()!, { recursive: true, force: true });
    });

    defineSteps(({ Step }) => {
      Step('a webhook subscription {string} exists', async (_ctx, name: string) => {
        await runtimeRequest(env.port, 'POST', '/agents/webhook-subscriptions', {
          name,
          deliverOnly: true,
          prompt: 'Original prompt',
          authType: 'none',
        });
      });
      Step('I see {string}', async (_ctx, text: string) => {
        await session!.waitForFrame(text, 10_000);
      });
    });

    Scenario('Pause a subscription from the list', ({ When, Then }) => {
      When('I open the webhooks panel', async () => {
        await openPanel();
      });
      When('I press space on the selected subscription', () => {
        // One seeded row, so it is the selected one.
        session!.send(' ');
      });
      Then('the stored subscription {string} is paused', async (_ctx, name: string) => {
        await expect.poll(async () => (await storedSubscription(name))?.isActive, { timeout: 10_000 }).toBe(false);
        await session!.waitForFrame('✗', 5_000);
      });
    });

    Scenario('Edit a subscription, with the prompt written in the editor', ({ When, And, Then }) => {
      When(
        'I open the webhooks panel with an editor that writes {string}',
        async (_ctx, text: string) => {
          await openPanel(makeEditor(text));
        },
      );
      And(
        'I edit {string} with the description {string} and a prompt from the editor',
        async (_ctx, name: string, description: string) => {
          // The list is on screen, so the panel is already reading keys. Enter
          // saves once the form is open, so it is sent once, never resent.
          session!.send(KEYS.ENTER);
          await session!.waitForFrame(`Edit webhook ${name}`, 5_000);
          await sleep(300);
          session!.send(description);
          await session!.waitForFrame(new RegExp(`Description\\s+${description}`), 5_000);
          // Description → Events → Deliver to → Deliver only → Prompt.
          for (let i = 0; i < 4; i++) {
            session!.send(KEYS.DOWN);
            await sleep(150);
          }
          await session!.waitForFrame(/space open in/, 5_000);
          session!.send(' ');
          await session!.waitForFrame(/Edited prompt/, 30_000);
          session!.send(KEYS.ENTER);
        },
      );
      Then(
        'the stored subscription {string} has the description {string} and the prompt {string}',
        async (_ctx, name: string, description: string, prompt: string) => {
          await expect
            .poll(
              async () => {
                const s = await storedSubscription(name);
                return { description: s?.description, prompt: s?.prompt };
              },
              { timeout: 10_000 },
            )
            .toEqual({ description, prompt });
        },
      );
    });
  },
);
