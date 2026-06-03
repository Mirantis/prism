/**
 * Interactive panels driven through the real PTY: /schedules and /config.
 *
 * Per the suite's documented PTY constraint (slash-commands.test.ts), Tab and
 * arrow-key navigation aren't keyboard-driven here — so the create form and
 * /config scrolling are exercised only at the single-key level (open, d-y
 * delete). Create + state are seeded and verified via the runtime's REST API;
 * that logic is also unit-tested in cli/. Panel-close via Esc is isolated to
 * one dedicated test so its escape-sequence handling can't mask the core
 * open/list/delete assertions, which rely only on Enter + plain characters.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, clearCronTasks, runtimeRequest, type RuntimeTestEnv } from '../setup';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Type a command line and submit it (the popup hides on the first space). */
async function dispatch(session: TuiSession, line: string): Promise<void> {
  session.send(line);
  await sleep(300);
  session.send(KEYS.ENTER);
}

describe('Prism CLI panels', () => {
  let env: RuntimeTestEnv;
  let session: TuiSession;

  beforeAll(async () => {
    env = await setupRuntime();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    // Order-independence: every spec starts with no cron tasks.
    await clearCronTasks(env.port);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, 30_000);
  });

  afterEach(async () => {
    await session.stop();
  });

  test('/schedules opens an empty panel', async () => {
    await dispatch(session, '/schedules');
    await session.waitForFrame(/Schedules/, 10_000);
    await session.waitForFrame(/No scheduled tasks/, 10_000);
  });

  test('/schedules lists a seeded task and deletes it via the UI', async () => {
    await runtimeRequest(env.port, 'POST', '/agents/cron-tasks', {
      name: 'E2E Daily Report',
      // Daily at 05:00 — a valid cron that won't fire during the test window.
      schedule: '0 5 * * *',
      instruction: 'noop',
    });

    await dispatch(session, '/schedules');
    await session.waitForFrame(/E2E Daily Report/, 10_000);

    // One seeded row → it's selected (index 0); delete needs no navigation.
    session.send('d');
    await session.waitForFrame(/Delete "E2E Daily Report"\? \(y\/n\)/, 5_000);
    session.send('y');
    await session.waitForFrame(/No scheduled tasks/, 10_000);

    const tasks = await runtimeRequest<unknown[]>(env.port, 'GET', '/agents/cron-tasks');
    expect(tasks).toEqual([]);
  });

  test('/schedules opens the create form', async () => {
    await dispatch(session, '/schedules');
    await session.waitForFrame(/No scheduled tasks/, 10_000);

    session.send('n');
    await session.waitForFrame(/New schedule/, 5_000);
    await session.waitForFrame(/Name/, 5_000);
    await session.waitForFrame(/Schedule/, 5_000);
    await session.waitForFrame(/Instruction/, 5_000);

    // Opening the form alone must not have created anything.
    const tasks = await runtimeRequest<unknown[]>(env.port, 'GET', '/agents/cron-tasks');
    expect(tasks).toEqual([]);
  });

  test('/config shows identity and the config docs', async () => {
    await dispatch(session, '/config');
    await session.waitForFrame(/Model/, 10_000);
    // The first doc labels are above the fold regardless of terminal height.
    for (const label of ['Soul', 'User', 'Memory', 'Heartbeat']) {
      await session.waitForFrame(new RegExp(label), 5_000);
    }
  });

  test('Esc closes an open panel back to chat', async () => {
    await dispatch(session, '/config');
    await session.waitForFrame(/Model/, 10_000);

    session.send(KEYS.ESC);
    // Give Ink's escape-sequence timeout a beat to flush the lone ESC, then
    // confirm focus is back in the chat input: it echoes typed characters,
    // whereas the panel does not echo arbitrary text. We never press Enter, so
    // the sentinel is discarded when the session stops.
    await sleep(400);
    session.send('sentinel-back-in-chat');
    await session.waitForFrame(/sentinel-back-in-chat/, 5_000);
  });
});
