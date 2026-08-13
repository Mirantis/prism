/**
 * Interactive panels driven through the real PTY: /schedules and /config.
 *
 * Per the suite's documented PTY constraint (slash-commands.feature), Tab and
 * arrow-key navigation aren't keyboard-driven here — so the create form and
 * /config scrolling are exercised only at the single-key level (open, d-y
 * delete). Create + state are seeded and verified via the runtime's REST API;
 * that logic is also unit-tested in cli/. Panel-close via Esc is isolated to
 * one scenario so its escape-sequence handling can't mask the core
 * open/list/delete assertions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, clearCronTasks, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/panels.feature'), 'utf8'),
);

const SEEDED_TASK = 'E2E Daily Report';

let env: RuntimeTestEnv;
let session: TuiSession;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Type a command line and submit it (the popup hides on the first space). */
async function dispatch(line: string): Promise<void> {
  session.send(line);
  await sleep(300);
  session.send(KEYS.ENTER);
}

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario, defineSteps }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    // Order-independence: every scenario starts with no cron tasks.
    await clearCronTasks(env.port);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  defineSteps(({ Step }) => {
    Step('I see {string}', async (_ctx, text: string) => {
      await session.waitForFrame(text, 10_000);
    });
    Step('I open the schedules panel', async () => {
      await dispatch('/schedules');
    });
    Step('I open the config panel', async () => {
      await dispatch('/config');
    });
    Step('no cron tasks remain', async () => {
      const tasks = await runtimeRequest<unknown[]>(env.port, 'GET', '/agents/cron-tasks');
      expect(tasks).toEqual([]);
    });
  });

  Scenario('/schedules opens an empty panel', () => {
    // Covered by the shared "open" + "I see" steps.
  });

  Scenario('/schedules lists a seeded task and deletes it via the UI', ({ Given, When }) => {
    Given('a cron task {string} exists', async (_ctx, name: string) => {
      await runtimeRequest(env.port, 'POST', '/agents/cron-tasks', {
        name,
        // Daily at 05:00 — a valid cron that won't fire during the test window.
        schedule: '0 5 * * *',
        instruction: 'noop',
      });
    });
    When('I delete the selected task and confirm', async () => {
      // One seeded row → it's selected (index 0); delete needs no navigation.
      session.send('d');
      await session.waitForFrame(new RegExp(`Delete "${SEEDED_TASK}"\\? \\(y/n\\)`), 5_000);
      session.send('y');
    });
    // "Then I see …" and "And no cron tasks remain" come from the shared steps.
  });

  Scenario('/schedules opens the create form', ({ When }) => {
    When('I open the create form', async () => {
      session.send('n');
    });
    // Assertions ("New schedule", "Name", … and "no cron tasks remain") are
    // covered by the shared steps.
  });

  Scenario('/config shows identity, the focused file list, and the config docs', ({ And }) => {
    And('I see the config doc labels', async () => {
      // The first doc labels are above the fold regardless of terminal height.
      for (const label of ['Soul', 'User', 'Memory', 'Heartbeat']) {
        await session.waitForFrame(new RegExp(label), 5_000);
      }
    });
  });

  Scenario('Esc closes an open panel back to chat', ({ When, Then }) => {
    When('I press Escape', () => {
      session.send(KEYS.ESC);
    });
    Then('the chat input is focused again', async () => {
      // Give Ink's escape-sequence timeout a beat to flush the lone ESC, then
      // confirm focus is back in the chat input: it echoes typed characters,
      // whereas the panel does not. We never press Enter, so the sentinel is
      // discarded when the session stops.
      await sleep(400);
      session.send('sentinel-back-in-chat');
      await session.waitForFrame(/sentinel-back-in-chat/, 5_000);
    });
  });
});
