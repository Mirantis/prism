/**
 * Runtime Helper — talks to the agent-runtime's management API.
 *
 * The Playwright suite otherwise resets state by deleting rows through Prisma
 * (`db-helper.resetAll`). That is enough for anything the runtime re-reads per
 * request, and not enough for anything it holds in memory: the cron scheduler
 * keeps a node-cron job per task, and the goal service keeps a loop per active
 * goal. Deleting those rows underneath a long-lived runtime leaves the timer and
 * the loop running, so work a *previous* scenario scheduled fires during a later
 * one — an unexplained agent message mid-scenario, or a model call competing
 * with the turn under test.
 *
 * Mirrors `tui/setup.ts#clearCronTasks`, which the TUI suite already does per
 * spec. That suite gets away with only cron because each spec file owns a
 * short-lived runtime; here one runtime spans the whole suite.
 */

const RUNTIME_PORT = 3003;

async function runtimeRequest<T>(
  method: 'GET' | 'DELETE' | 'PATCH',
  reqPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://localhost:${RUNTIME_PORT}${reqPath}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`runtimeRequest ${method} ${reqPath} → ${res.status}: ${detail}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Close the webhook receiver, unschedule cron tasks and stop live goals through
 * the API before resetting their saved state.
 *
 * Call *before* the raw DB wipe: once the rows are gone the runtime has nothing
 * left to enumerate, and the timers survive.
 *
 * Best effort by design — a reset failure must not be reported as a failure of
 * the scenario that happens to run next. A warning is enough: whatever leaked
 * shows up in that scenario's own trace.
 */
export async function resetScheduledWork(): Promise<void> {
  try {
    await runtimeRequest('PATCH', '/agents/webhooks/receiver', { enabled: false });
    const tasks = await runtimeRequest<Array<{ id: string }>>('GET', '/agents/cron-tasks');
    for (const task of tasks) {
      await runtimeRequest('DELETE', `/agents/cron-tasks/${task.id}`);
    }

    // Only `active`/`paused` goals hold a runtime loop; the rest are history.
    const goals = await runtimeRequest<Array<{ id: string; status: string }>>('GET', '/agents/goals');
    for (const goal of goals.filter((g) => g.status === 'active' || g.status === 'paused')) {
      await runtimeRequest('DELETE', `/agents/goals/${goal.id}`);
    }
  } catch (error) {
    console.warn(
      `[e2e] Failed to reset scheduled work via the management API: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
