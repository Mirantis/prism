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
import Database from 'better-sqlite3';
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
  slackChannelIds: string[];
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

/** The Slack id a seeded channel is stored under, derived from its name. */
function seededChannelId(name: string): string {
  return `C${name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

/** Link channels to the agent straight in its database, oldest first. */
async function linkSlackChannels(names: string[]): Promise<void> {
  const { agentId, userId } = await runtimeRequest<{ agentId: string; userId: string }>(env.port, 'GET', '/agents/me');
  const db = new Database(env.dbPath);
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO slack_mappings (id, connectionId, agentId, lensUserId, slackChannelId, slackChannelName, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    names.forEach((name, i) => {
      const channelId = seededChannelId(name);
      insert.run(`map-${channelId}`, 'T0E2EWORKSPACE', agentId, userId, channelId, name, now + i, now + i);
    });
  } finally {
    db.close();
  }
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

    Scenario('Choose the Slack channel a Slack subscription posts to', ({ Given, And, When, Then }) => {
      Given('a Slack webhook subscription {string} exists', async (_ctx, name: string) => {
        await runtimeRequest(env.port, 'POST', '/agents/webhook-subscriptions', {
          name,
          deliverOnly: true,
          deliverTo: 'slack',
          prompt: 'Release {version} is out',
          authType: 'none',
        });
      });
      And(
        'the agent has the linked Slack channels {string} and {string}',
        async (_ctx, first: string, second: string) => {
          await linkSlackChannels([first, second]);
        },
      );
      When('I open the webhooks panel', async () => {
        await openPanel();
      });
      And(
        'I check the Slack channel {string} of {string} and save',
        async (_ctx, channel: string, name: string) => {
          // One seeded row, so it is the selected one. Enter saves once the
          // form is open, so it is sent once, never resent.
          session!.send(KEYS.ENTER);
          await session!.waitForFrame(`Edit webhook ${name}`, 5_000);
          await session!.waitForFrame(`[ ] #${channel}`, 5_000);
          // Description → Events → May post to → the first channel → the second.
          for (let i = 0; i < 4; i++) {
            session!.send(KEYS.DOWN);
            await sleep(150);
          }
          session!.send(' ');
          await session!.waitForFrame(`[x] #${channel}`, 5_000);
          session!.send(KEYS.ENTER);
        },
      );
      Then(
        'the stored subscription {string} posts to the Slack channel {string}',
        async (_ctx, name: string, channel: string) => {
          await expect
            .poll(async () => (await storedSubscription(name))?.slackChannelIds, { timeout: 10_000 })
            .toEqual([seededChannelId(channel)]);
        },
      );
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
          // Description → Events → May post to → Deliver only → Prompt.
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
