/**
 * Slash-command UI: popup visibility on '/', and dispatch via typing the full
 * command name and pressing Enter twice — the first Enter completes the
 * highlighted row and closes the popup, the second runs the command. None of
 * these scenarios call the LLM — slash commands run locally inside `prism`.
 * A Ctrl+O chord leaking into the composer is covered by tool-calls.feature.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/slash-commands.feature'), 'utf8'),
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
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Typing a slash shows the command popup', ({ When, Then, And }) => {
    When('I type a forward slash', () => {
      session.send('/');
    });
    Then('the popup lists the available commands', async () => {
      // Assert on the top of the list (stable as commands are added) rather
      // than a command that may scroll past the window.
      await session.waitForFrame(/\/copy/, 5_000);
      await session.waitForFrame(/\/schedules/, 5_000);
    });
    And('the first command is highlighted', async () => {
      await session.waitForFrame(/▸\s*\/copy/, 2_000);
    });
  });

  Scenario('Enter completes the highlighted command and a second Enter dispatches it', ({ When, Then }) => {
    When('I type /copy and press Enter twice', async () => {
      // First Enter accepts "/copy" into the composer as "/copy " (the same as
      // Tab), which closes the popup; only the second dispatches. Typing a full
      // command name and pressing Enter once no longer runs it.
      session.send('/copy');
      await session.waitForFrame(/▸\s*\/copy/, 5_000);
      session.send(KEYS.ENTER);
      await session.sendUntilFrame(KEYS.ENTER, /No message to copy yet/, { timeoutMs: 5_000 });
    });
    Then('I see the "no message to copy" notice', async () => {
      await session.waitForFrame(/No message to copy yet/, 5_000);
    });
  });

  Scenario('The arrow keys move the highlight and Tab completes the command', ({ When, Then }) => {
    When('I type "/he" and press the down arrow', async () => {
      session.send('/he');
      await session.waitForFrame(/▸\s*\/heartbeat-model/, 5_000);
      session.send(KEYS.DOWN);
    });
    Then('the second matching command is highlighted', async () => {
      // "/heartbeat-model", "/heartbeat" and "/help" match "/he", in that order.
      await expect.poll(() => session.screen(), { timeout: 5_000 }).toMatch(/▸\s*\/heartbeat\s+Control the heartbeat/);
    });
    When('I press Tab and then Enter', async () => {
      session.send(KEYS.TAB);
      // Tab leaves "/heartbeat " in the composer, whose trailing space closes the popup.
      await expect.poll(() => session.screen(), { timeout: 5_000 }).toMatch(/› \/heartbeat\s/);
      session.send(KEYS.ENTER);
    });
    Then('I see the "/heartbeat" usage notice', async () => {
      await session.waitForFrame('Usage: /heartbeat <status|start|stop|trigger|every Nm|Nh>.', 5_000);
    });
  });

  Scenario('The up arrow recalls the last line I submitted', ({ Given, When, Then }) => {
    Given('I ran the "/help" command', async () => {
      session.send('/help ');
      await session.waitForFrame(/›\s*\/help/, 5_000);
      session.send(KEYS.ENTER);
      await session.waitForFrame('/exit — Shut down the TUI', 5_000);
      await expect.poll(() => session.screen(), { timeout: 5_000 }).toMatch(/│ ›\s+│/);
    });
    When('I press the up arrow in the empty composer', () => {
      session.send(KEYS.UP);
    });
    Then('the composer holds "/help" again', async () => {
      await expect.poll(() => session.screen(), { timeout: 5_000 }).toMatch(/│ › \/help/);
    });
  });
});
