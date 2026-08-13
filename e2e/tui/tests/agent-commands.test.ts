/**
 * Management slash commands that hit the runtime's /agents/* REST API:
 * /help, /rename, /model, /heartbeat. None of these call the LLM, so the
 * assertions are deterministic and don't need Bedrock. Each command's
 * on-screen SYSTEM reply is asserted in the PTY frame, and the persistent
 * side effect is confirmed with a direct REST query against the runtime.
 *
 * /heartbeat trigger is intentionally omitted: it awaits a full heartbeat run
 * (LLM) and is covered by the cli/ unit tests instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/agent-commands.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
// Captured in the /model scenario's Given so the reset assertions can compare.
let defaultModel = '';

/**
 * Type a full command line (including any arguments) and submit it. We avoid
 * waiting on the slash popup — it hides as soon as a space is typed — and give
 * Ink a beat to commit the value into App state before Enter.
 */
async function dispatch(line: string): Promise<void> {
  session.send(line);
  await new Promise((r) => setTimeout(r, 300));
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
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  // Shared steps — matched by text across any keyword (Given/When/Then/And).
  defineSteps(({ Step }) => {
    Step('I run {string}', async (_ctx, line: string) => {
      await dispatch(line);
    });
    Step('I see {string}', async (_ctx, text: string) => {
      // waitForFrame accepts a plain string (substring match), so on-screen
      // text with regex-special characters needs no escaping.
      await session.waitForFrame(text, 10_000);
    });
  });

  Scenario('/help lists the management commands with descriptions', () => {
    // Covered entirely by the shared "I run" / "I see" steps.
  });

  Scenario('/rename updates the agent name preserving spaces', ({ Then, And }) => {
    Then('the rename to {string} is confirmed', async (_ctx, name: string) => {
      await session.waitForFrame(`Renamed to "${name}"`, 10_000);
    });
    And('the stored agent name is {string}', async (_ctx, name: string) => {
      const me = await runtimeRequest<{ name: string }>(env.port, 'GET', '/agents/me');
      expect(me.name).toBe(name);
    });
  });

  Scenario('/model sets then resets the model override', ({ Given, Then, And, When }) => {
    Given('the agent starts on its default model', async () => {
      const res = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
      defaultModel = res.model ?? '';
      expect(defaultModel.length).toBeGreaterThan(0);
    });
    Then('the model is set to {string}', async (_ctx, model: string) => {
      await session.waitForFrame(`Model set to "${model}"`, 10_000);
      const res = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
      expect(res.model).toBe(model);
    });
    And('the stored model is {string}', async (_ctx, model: string) => {
      const res = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
      expect(res.model).toBe(model);
    });
    When('I reset the model to its default', async () => {
      await dispatch('/model reset');
    });
    Then('the model is set back to the default', async () => {
      // Reset clears the override; the effective model returns to the default,
      // which the command echoes. Waiting on this frame also avoids racing the
      // REST read against the in-flight PATCH.
      await session.waitForFrame(`Model set to "${defaultModel}"`, 10_000);
    });
    And('the stored model is the default', async () => {
      const res = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
      expect(res.model).toBe(defaultModel);
    });
  });

  Scenario('/heartbeat-model sets then resets the heartbeat model override', ({ Then }) => {
    Then('the heartbeat model is set to {string}', async (_ctx, model: string) => {
      await session.waitForFrame(`Heartbeat model set to "${model}"`, 10_000);
      const res = await runtimeRequest<{ model: string | null; effective: string }>(
        env.port,
        'GET',
        '/agents/heartbeat-model',
      );
      expect(res.model).toBe(model);
    });
    Then('the heartbeat model is cleared to the main model', async () => {
      await session.waitForFrame('Heartbeat model reset', 10_000);
      const res = await runtimeRequest<{ model: string | null; effective: string }>(
        env.port,
        'GET',
        '/agents/heartbeat-model',
      );
      // Override cleared; effective falls back to the main/default model.
      expect(res.model).toBeNull();
      expect(res.effective.length).toBeGreaterThan(0);
    });
  });

  Scenario('/cron-model sets then resets the scheduled-task model override', ({ Then }) => {
    Then('the cron model is set to {string}', async (_ctx, model: string) => {
      await session.waitForFrame(`Scheduled-task model set to "${model}"`, 10_000);
      const res = await runtimeRequest<{ model: string | null; effective: string }>(
        env.port,
        'GET',
        '/agents/cron-model',
      );
      expect(res.model).toBe(model);
    });
    Then('the cron model is cleared to the main model', async () => {
      await session.waitForFrame('Scheduled-task model reset', 10_000);
      const res = await runtimeRequest<{ model: string | null; effective: string }>(
        env.port,
        'GET',
        '/agents/cron-model',
      );
      expect(res.model).toBeNull();
      expect(res.effective.length).toBeGreaterThan(0);
    });
  });

  Scenario('/heartbeat status reports the current state', () => {
    // Covered by the shared steps.
  });

  Scenario('/heartbeat stop then start toggles isActive', ({ And }) => {
    And('the heartbeat is inactive', async () => {
      const status = await runtimeRequest<{ isActive: boolean }>(env.port, 'GET', '/agents/heartbeat/status');
      expect(status.isActive).toBe(false);
    });
    And('the heartbeat is active', async () => {
      const status = await runtimeRequest<{ isActive: boolean }>(env.port, 'GET', '/agents/heartbeat/status');
      expect(status.isActive).toBe(true);
    });
  });

  Scenario('/heartbeat every 5m updates the interval', ({ And }) => {
    And('the heartbeat interval is {int} ms', async (_ctx, ms: number) => {
      const status = await runtimeRequest<{ intervalMs?: number }>(env.port, 'GET', '/agents/heartbeat/status');
      expect(status.intervalMs).toBe(ms);
    });
  });

  Scenario('/heartbeat with an unknown subcommand shows usage', () => {
    // Covered by the shared steps.
  });
});
