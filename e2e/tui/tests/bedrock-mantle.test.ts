/**
 * End-to-end coverage for `LLM_PROVIDER=bedrock-mantle` against the real AWS
 * mantle endpoint (`https://bedrock-mantle.{region}.api.aws/anthropic/v1`).
 *
 * This is the only coverage that proves two things unit tests structurally
 * cannot: that mantle actually serves the model IDs we default to (they are
 * bare, and the versioned `…-20251001-v1:0` shape bedrock-runtime uses 404s
 * there), and that a `us.`-prefixed override read back out of a real database
 * row survives the round trip.
 *
 * Replies are asserted against stored AGENT rows rather than the frame, for the
 * reason chat.test.ts documents: the composer stays live during a turn, so the
 * sentinel is on screen the instant it is typed and a frame matcher would pass
 * against the user's own draft.
 *
 * Requires `AWS_BEARER_TOKEN_BEDROCK` — mantle's Anthropic surface has no SigV4
 * path, so unlike the Bedrock suites this cannot fall back to AWS_ACCESS_KEY_ID.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import stripAnsi from 'strip-ansi';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import {
  setupRuntime,
  resetThread,
  runtimeRequest,
  waitForStoredMessage,
  type RuntimeTestEnv,
} from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/bedrock-mantle.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;

describeFeature(
  feature,
  ({
    BeforeAllScenarios,
    AfterAllScenarios,
    BeforeEachScenario,
    AfterEachScenario,
    Scenario,
  }) => {
    BeforeAllScenarios(async () => {
      env = await setupRuntime({
        runtimeEnvOverrides: {
          LLM_PROVIDER: 'bedrock-mantle',
          // Drop any ambient BEDROCK_MODEL_ID the shell or CI sets: it carries a
          // `us.` inference-profile prefix mantle rejects, and the mantle model
          // IDs deliberately do not inherit from it. Letting the runtime's own
          // bare defaults win is the configuration worth covering.
          BEDROCK_MODEL_ID: undefined,
        },
      });
    });
    AfterAllScenarios(async () => {
      await env.cleanup();
    });
    BeforeEachScenario(async () => {
      resetThread(env.dbPath);
      // Clear any per-agent override a previous scenario set, so scenarios stay
      // order-independent.
      await runtimeRequest(env.port, 'PATCH', '/agents/model', { model: null });
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
    });
    AfterEachScenario(async () => {
      await session.stop();
    });

    Scenario('Boots with the mantle provider selected', ({ Then, And }) => {
      Then(
        'the startup log reports provider {string} routing {string}',
        (_ctx, provider: string, routing: string) => {
          // One line proves both halves of the selection: the vendor branch in
          // createProvider(), and that `nexusChatBaseUrl` resolved to the mantle
          // mount rather than the bedrock-runtime one (NEXUS_API_URL is unset in
          // this suite, so 'direct').
          const log = logText();
          expect(log).toMatch(new RegExp(`provider:\\s*"?${provider}"?`));
          expect(log).toMatch(new RegExp(`routing:\\s*"?${routing}"?`));
        },
      );
      And('the resolved chat model is a bare Bedrock ID', () => {
        const log = logText();
        const match = /chatModel:\s*"?([\w.:-]+)"?/.exec(log);
        expect(match, `no chatModel in startup log:\n${log}`).not.toBeNull();
        // Mantle has no cross-region inference profiles, so a prefixed ID here
        // would 404 on the first turn.
        expect(match![1]).not.toMatch(/^(us|us-gov|eu|apac|jp|au|ca|global)\./);
        expect(match![1]).toMatch(/^anthropic\./);
      });
    });

    Scenario('Answers a chat turn over the mantle endpoint', ({ When, Then, And }) => {
      When('I send the prompt {string}', async (_ctx, prompt: string) => {
        await sendPrompt(prompt);
      });
      Then('the agent reply contains {string}', async (_ctx, sentinel: string) => {
        await waitForStoredMessage(env.dbPath, 'AGENT', sentinel, 120_000);
      });
      And('no model was rejected by the endpoint', () => {
        // The classification gate and thread-title call use a *different* model
        // from chat, so a reply alone doesn't prove every default resolves.
        // `anthropic.claude-haiku-4-5-20251001-v1:0` — the shape bedrock-runtime
        // wants — 404s here, and that failure is caught and logged rather than
        // surfaced to the user.
        expect(logText()).not.toMatch(/does not exist/);
      });
    });

    Scenario(
      'Strips a cross-region prefix from a stored model override',
      ({ Given, When, Then, And }) => {
        Given("the agent's model override is {string}", async (_ctx, model: string) => {
          // The realistic failure this guards: a deployment switched to mantle
          // whose agent row still holds the Bedrock-shaped ID it was created
          // with. The value is stored verbatim — normalization happens at
          // dispatch, so it stays valid if the operator switches back.
          const res = await runtimeRequest<{ model: string }>(
            env.port,
            'PATCH',
            '/agents/model',
            { model },
          );
          expect(res.model).toBe(model);
        });
        When('I send the prompt {string}', async (_ctx, prompt: string) => {
          await sendPrompt(prompt);
        });
        Then('the agent reply contains {string}', async (_ctx, sentinel: string) => {
          // A reply at all means the prefixed override never reached mantle.
          await waitForStoredMessage(env.dbPath, 'AGENT', sentinel, 120_000);
        });
        And('the runtime logged that it stripped the inference-profile prefix', () => {
          expect(logText()).toMatch(/Stripped cross-region inference-profile prefix/);
        });
      },
    );
  },
);

/** Type a prompt into the composer and submit it. */
async function sendPrompt(prompt: string): Promise<void> {
  session.send(prompt);
  // Let the text input commit the appended chars before Enter — without this the
  // keystrokes can race and Enter submits with a stale value.
  await new Promise((r) => setTimeout(r, 200));
  session.send(KEYS.ENTER);
}

/**
 * Runtime log with ANSI stripped. The harness buffers the runtime's stdout
 * verbatim and `NODE_ENV=development` puts pino behind pino-pretty with
 * `colorize: true`, so raw escape codes sit between each key and its value.
 */
function logText(): string {
  return stripAnsi(env.runtime.logTail(400_000));
}
