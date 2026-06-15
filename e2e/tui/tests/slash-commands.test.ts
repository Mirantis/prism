/**
 * Slash-command UI: popup visibility on '/', and direct dispatch via typing
 * the full command name + Enter. None of these scenarios call the LLM — slash
 * commands run locally inside prism-cli.
 *
 * Tab autocomplete and arrow-key navigation are exercised manually via
 * `npm run dev --workspace=prism-cli` — under the test PTY they run into Ink
 * keystroke parsing quirks that aren't worth chasing here, and the main
 * regression risk (the `swallowNextChangeRef` ordering with Ctrl+O) is covered
 * by tool-calls.feature.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
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
    await session.waitForFrame(/Prism/, 30_000);
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

  Scenario('Typing a command name and Enter dispatches it', ({ When, Then }) => {
    When('I submit the /copy command', async () => {
      // Direct dispatch — bypasses Tab. /copy with no prior message returns
      // the "No message to copy yet." SYSTEM line.
      session.send('/copy');
      await session.waitForFrame(/▸\s*\/copy/, 5_000);
      session.send(KEYS.ENTER);
    });
    Then('I see the "no message to copy" notice', async () => {
      await session.waitForFrame(/No message to copy yet/, 5_000);
    });
  });
});
