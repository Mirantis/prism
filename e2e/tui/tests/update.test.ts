/**
 * Self-update disabled-state surfaces. The e2e runtime runs from source (tsx,
 * not a SEA binary), so the updater reports `not_sea_install` — the honest
 * end-to-end assertion here is that both entry points surface that state and
 * exit cleanly. The enabled path (download, swap, restart) is exercised by
 * unit tests and the manual smoke on a real packaged install.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/update.feature'), 'utf8'),
);

const OTHER_MEANS_NOTICE = /This install updates by other means/;

let env: RuntimeTestEnv;
let session: TuiSession | null = null;

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  AfterEachScenario(async () => {
    if (session) await session.stop();
    session = null;
  });

  Scenario('/update reports why updates are off in this install', ({ When, Then }) => {
    When('I submit the /update command', async () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
      // The trailing space closes the slash popup, so one Enter runs the
      // command. Without it Enter only accepts the highlighted row — the
      // Enter-completes path is slash-commands.test.ts's subject.
      session.send('/update ');
      // Enter has to be a write of its own: Ink's input parser splits text on
      // backspace bytes and never on CR, so a coalesced `/update \r` read is
      // inserted into the composer as text and no submit happens. Waiting for
      // the typed line proves the first write was consumed; `sendUntilFrame`
      // then covers a keystroke lost at mount.
      await session.waitForFrame(/›\s*\/update/, 5_000);
      await session.sendUntilFrame(KEYS.ENTER, OTHER_MEANS_NOTICE, { timeoutMs: 10_000 });
    });
    Then('I see the "updates by other means" notice', async () => {
      await session!.waitForFrame(OTHER_MEANS_NOTICE, 10_000);
    });
  });

  Scenario('prism update exits cleanly when the install cannot self-update', ({ When, Then }) => {
    When('I run prism update against the dev runtime', () => {
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, args: ['update'] });
    });
    Then('it prints the "updates by other means" notice and exits 0', async () => {
      await session!.waitForFrame(OTHER_MEANS_NOTICE, 15_000);
      const code = await session!.waitForExit(10_000);
      expect(code).toBe(0);
    });
  });

  Scenario('prism update fails fast when the server is down', ({ When, Then }) => {
    When('I run prism update against a stopped server', () => {
      session = startPrism({
        env: { ...env.prismEnv, PRISM_HTTP_URL: 'http://127.0.0.1:3999' },
        args: ['update'],
      });
    });
    Then('it prints the unreachable-server message and exits 1', async () => {
      await session!.waitForFrame(/prism-server is not reachable/, 15_000);
      const code = await session!.waitForExit(10_000);
      expect(code).toBe(1);
    });
  });
});
