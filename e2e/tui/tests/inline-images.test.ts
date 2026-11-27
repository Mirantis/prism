/**
 * An image the agent places in its reply, drawn at its place in the terminal UI.
 * The agent writes a PNG with its shell and places it between two words, as the
 * web suite's file-sharing scenario does. The PTY answers the CLI's start-up
 * probe as the terminal under test would, which selects how the CLI draws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type StartPrismOptions, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(path.join(import.meta.dirname, '../features/inline-images.feature'), 'utf8'),
);

// A 24×24 PNG, the one the web suite's scenario places.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGNQTX5NFcQwatCoQaMGjRo0atCoQQNvEABZoULu4chlggAAAABJRU5ErkJggg==';

const REPLY_TIMEOUT_MS = 300_000;

let env: RuntimeTestEnv;
let session: TuiSession | undefined;
let workspace: string;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function start(terminal: NonNullable<StartPrismOptions['terminal']>): Promise<void> {
  session = startPrism({ env: env.prismEnv, runtime: env.runtime, terminal });
  await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
}

/** Only the picture's placeholder cells and white space lie between the two words. */
function drawnBetween(before: string, after: string): RegExp {
  return new RegExp(`${before}[\\s\\u{10EEEE}\\u0300-\\u05FF]*\\u{10EEEE}[\\s\\u{10EEEE}\\u0300-\\u05FF]*${after}`, 'u');
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    // The agent writes the PNG here before it places it.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-images-ws-'));
    env = await setupRuntime({ runtimeEnvOverrides: { SHELL_WORKSPACE_ROOT: workspace } });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  BeforeEachScenario(() => {
    resetThread(env.dbPath);
  });
  AfterEachScenario(async () => {
    await session?.stop();
    session = undefined;
  });

  const ask = async (before: string, after: string): Promise<void> => {
    session!.send(
      `Run this exact shell command: printf '%s' '${PNG_BASE64}' | base64 -d > chart.png. ` +
        `Reply in three lines: the word ${before}, then the image chart.png shown inside your reply, then the word ${after}.`,
    );
    await sleep(200);
    session!.send(KEYS.ENTER);
    await session!.waitForFrame(/▌ You/, 5_000);
  };

  Scenario("A terminal without kitty graphics shows the image's description", ({ Given, When, Then }) => {
    Given('the CLI runs in a terminal that answers only the device attributes', async () => {
      await start('plain');
    });
    When('I ask the agent to show an image between {string} and {string}', async (_ctx, before: string, after: string) => {
      await ask(before, after);
    });
    Then(
      "the reply shows the image's description between {string} and {string}",
      async (_ctx, before: string, after: string) => {
        await session!.waitForFrame(new RegExp(`${before}\\s*\\[image: [^\\]]*\\]\\s*${after}`), REPLY_TIMEOUT_MS);
        expect(session!.rawOutput()).not.toContain('\x1b_Ga=T');
      },
    );
  });

  // Each terminal whose answer to the probe selects kitty graphics, with the scenario and its Given step.
  const kittyTerminals = [
    ['kitty', 'A kitty terminal draws the image with the kitty graphics protocol', 'the CLI runs in a kitty terminal'],
    ['rex', 'Rex draws the image with the kitty graphics protocol', 'the CLI runs in Rex'],
    ['rio', 'Rio draws the image with the kitty graphics protocol', 'the CLI runs in Rio'],
    [
      'placeholders',
      'A terminal that reports Unicode placeholders draws the image, whatever its name',
      'the CLI runs in a terminal that reports Unicode placeholders',
    ],
  ] as const;

  for (const [terminal, title, given] of kittyTerminals) {
    Scenario(title, ({ Given, When, Then, And }) => {
      Given(given, async () => {
        await start(terminal);
      });
      When('I ask the agent to show an image between {string} and {string}', async (_ctx, before: string, after: string) => {
        await ask(before, after);
      });
      Then('the CLI stores the image in the terminal', async () => {
        await session!.waitForFrame(/▌\s+Prism\b/, REPLY_TIMEOUT_MS);
        const deadline = Date.now() + 60_000;
        while (!/\x1b_Ga=T,U=1,i=\d+,/.test(session!.rawOutput()) && Date.now() < deadline) await sleep(100);
        expect(session!.rawOutput()).toMatch(/\x1b_Ga=T,U=1,i=\d+,c=\d+,r=\d+,f=32,s=\d+,v=\d+,o=z,q=2,m=[01];/);
      });
      And(
        "the reply draws the image's placeholders between {string} and {string}",
        async (_ctx, before: string, after: string) => {
          await session!.waitForFrame(drawnBetween(before, after), 60_000);
          // Each placeholder row is colored with the id the image was stored under.
          const id = Number(/\x1b_Ga=T,U=1,i=(\d+),/.exec(session!.rawOutput())![1]);
          const color = `\x1b[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m\u{10EEEE}`;
          expect(session!.rawOutput()).toContain(color);
        },
      );
    });
  }
});
