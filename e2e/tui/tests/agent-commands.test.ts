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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, runtimeRequest, type RuntimeTestEnv } from '../setup';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Type a full command line (including any arguments) and submit it. We avoid
 * waiting on the slash popup — it hides as soon as a space is typed — and
 * instead give Ink a beat to commit the value into App state before Enter,
 * mirroring the real typing cadence (same approach as tool-calls.test.ts).
 */
async function dispatch(session: TuiSession, line: string): Promise<void> {
  session.send(line);
  await sleep(300);
  session.send(KEYS.ENTER);
}

describe('Prism CLI management commands', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;

  beforeAll(async () => {
    env = await setupRuntime();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
  });

  test('/help lists the management commands with descriptions', async () => {
    await dispatch(session, '/help');
    // These descriptions live only in the help body — the popup was filtered to
    // the /help prefix, so matching them proves we rendered the command output.
    await session.waitForFrame(/Manage scheduled cron tasks/, 10_000);
    await session.waitForFrame(/Control the heartbeat/, 5_000);
  });

  test('/rename updates the agent name (preserving spaces)', async () => {
    await dispatch(session, '/rename E2E Renamed Bot');
    await session.waitForFrame(/Renamed to "E2E Renamed Bot"/, 10_000);

    const me = await runtimeRequest<{ name: string }>(env.port, 'GET', '/agents/me');
    expect(me.name).toBe('E2E Renamed Bot');
  });

  test('/model sets then resets the model override', async () => {
    // Pristine effective model (no override on a freshly bootstrapped agent).
    // The runtime always resolves a default, so PATCH /agents/model with null
    // returns this same string — the command echoes it as `Model set to …`,
    // never the empty-model branch.
    const { model: defaultModel } = await runtimeRequest<{ model: string | null }>(
      env.port,
      'GET',
      '/agents/model',
    );
    expect((defaultModel ?? '').length).toBeGreaterThan(0);

    await dispatch(session, '/model my-test-model');
    await session.waitForFrame(/Model set to "my-test-model"/, 10_000);
    let model = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
    expect(model.model).toBe('my-test-model');

    await dispatch(session, '/model reset');
    // Reset clears the override; the effective model returns to the default,
    // which the command echoes. Waiting on this frame also avoids racing the
    // REST read below against the in-flight PATCH.
    await session.waitForFrame(`Model set to "${defaultModel}"`, 10_000);
    model = await runtimeRequest<{ model: string | null }>(env.port, 'GET', '/agents/model');
    expect(model.model).toBe(defaultModel);
  });

  test('/heartbeat status reports the current state', async () => {
    await dispatch(session, '/heartbeat status');
    await session.waitForFrame(/active:/, 10_000);
    await session.waitForFrame(/interval:/, 5_000);
  });

  test('/heartbeat stop then start toggles isActive', async () => {
    await dispatch(session, '/heartbeat stop');
    await session.waitForFrame(/Heartbeat stopped/, 10_000);
    let status = await runtimeRequest<{ isActive: boolean }>(
      env.port,
      'GET',
      '/agents/heartbeat/status',
    );
    expect(status.isActive).toBe(false);

    await dispatch(session, '/heartbeat start');
    await session.waitForFrame(/Heartbeat started/, 10_000);
    status = await runtimeRequest<{ isActive: boolean }>(
      env.port,
      'GET',
      '/agents/heartbeat/status',
    );
    expect(status.isActive).toBe(true);
  });

  test('/heartbeat every 5m updates the interval', async () => {
    await dispatch(session, '/heartbeat every 5m');
    await session.waitForFrame(/Heartbeat interval set to 300000ms\./, 10_000);

    const status = await runtimeRequest<{ intervalMs?: number }>(
      env.port,
      'GET',
      '/agents/heartbeat/status',
    );
    expect(status.intervalMs).toBe(300_000);
  });

  test('/heartbeat with an unknown subcommand shows usage', async () => {
    await dispatch(session, '/heartbeat wat');
    await session.waitForFrame(/Usage: \/heartbeat/, 10_000);
  });
});
