/**
 * Interactive panels driven through the real PTY: /schedules and /config.
 *
 * The create form moves between its fields with the Down arrow. State is seeded
 * and verified through the runtime's REST API. Panel-close via Esc is isolated to
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

/**
 * Type a command line and submit it. The trailing space closes the slash popup,
 * so one Enter runs the command — the Enter-completes path is covered by
 * slash-commands.test.ts.
 */
async function dispatch(line: string): Promise<void> {
  session.send(line + ' ');
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

  Scenario('/schedules creates a task only once it has an instruction', ({ When, And, Then }) => {
    When('I open the create form', async () => {
      session.send('n');
      await session.waitForFrame('New schedule', 10_000);
    });
    And(
      'I fill in the name {string} and the schedule {string}',
      async (_ctx, name: string, schedule: string) => {
        session.send(name);
        await session.waitForFrame(new RegExp(`Name\\s+${name}`), 5_000);
        session.send(KEYS.DOWN);
        await sleep(300);
        session.send(schedule);
        // The label beside the text says which field took it.
        await session.waitForFrame(new RegExp(`Schedule\\s+${schedule.replaceAll('*', '\\*')}`), 5_000);
      },
    );
    And('I press Enter', async () => {
      session.send(KEYS.ENTER);
      // A create would be one REST call; give it the time one takes.
      await sleep(1_500);
    });
    When('I fill in the instruction {string} and press Enter', async (_ctx, instruction: string) => {
      session.send(KEYS.DOWN);
      await sleep(300);
      session.send(instruction);
      await session.waitForFrame(new RegExp(`Instruction\\s+${instruction}`), 5_000);
      session.send(KEYS.ENTER);
    });
    Then(
      'the task {string} is created with the instruction {string}',
      async (_ctx, name: string, instruction: string) => {
        await expect
          .poll(
            async () =>
              (await runtimeRequest<Array<{ name: string; instruction: string }>>(env.port, 'GET', '/agents/cron-tasks')).map(
                (task) => ({ name: task.name, instruction: task.instruction }),
              ),
            { timeout: 10_000 },
          )
          .toEqual([{ name, instruction }]);
      },
    );
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
