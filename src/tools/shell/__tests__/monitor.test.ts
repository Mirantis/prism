/**
 * Behavior tests for `monitor`. Real subprocesses print the events, so the
 * line splitting, batching and the end of a watch run as they do in a turn;
 * only the conversation the notifications go to is a fake.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  begin: vi.fn(async () => undefined),
  update: vi.fn(),
  end: vi.fn(),
  deliver: vi.fn(async () => undefined),
  stopLeftover: vi.fn(async () => true),
  shutdown: new AbortController(),
}));

vi.mock('../../../services/pending-work.service', () => ({
  pendingWorkService: { begin: mocks.begin, update: mocks.update, end: mocks.end, shutdownSignal: mocks.shutdown.signal },
}));
vi.mock('../../../services/task-notification.service', () => ({
  taskNotificationService: { deliver: mocks.deliver },
}));
vi.mock('../../../lib/execution-environments/leftover-process', () => ({ stopLeftoverProcess: mocks.stopLeftover }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

import { runMonitor, runMonitorStop } from '../monitor';
import { MAX_MONITORS, __resetMonitorManagerForTests, getMonitorManager } from '../monitor-manager';

const notify = { threadId: 'thread-1', agentId: 'agent-1', userId: 'user-1', originChannel: 'websocket' };
let workspace: string;

/** The text of each notification sent so far. */
const sent = () => mocks.deliver.mock.calls.map((call) => (call as unknown[])[2] as string);

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-test-')));
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetMonitorManagerForTests();
});

afterEach(() => {
  __resetMonitorManagerForTests();
});

describe('monitor', () => {
  it('sends the lines printed together as one notification, then the exit as the last', async () => {
    const { monitorId } = await runMonitor(
      { command: 'echo "ERROR disk full"; echo "ERROR <b>retry</b>"; sleep 0.5; echo done; exit 3', description: 'errors in app.log' },
      workspace,
      notify,
    );
    await waitFor(() => sent().length === 3);

    expect(mocks.deliver).toHaveBeenCalledWith(notify, expect.any(String), expect.any(String));
    const [first, second, last] = sent();
    expect(first).toContain(`<task-notification monitor-id="${monitorId}" description="errors in app.log">`);
    // Escaped: the command's output cannot open or close a tag.
    expect(first).toContain('ERROR disk full\nERROR &lt;b&gt;retry&lt;/b&gt;');
    expect(second).toContain('\ndone\n');
    expect(last).toContain('status="ended" reason="exit" events="2" exit-code="3"');
    await waitFor(() => mocks.end.mock.calls.length > 0);
    expect(mocks.end).toHaveBeenCalledWith('monitor', monitorId);
  });

  it('stops the command at its deadline and says how to continue', async () => {
    await runMonitor({ command: 'sleep 30', description: 'deploy', timeoutMs: 1_000 }, workspace, notify);
    await waitFor(() => sent().length === 1);

    expect(sent()[0]).toContain('reason="timeout" events="0"');
    expect(sent()[0]).toContain('Start it again if the watch is still needed.');
    expect(getMonitorManager().runningCount()).toBe(0);
  });

  it('stops a command that prints more often than a monitor may', async () => {
    await runMonitor(
      { command: 'for i in $(seq 1 40); do echo "line $i"; sleep 0.25; done', description: 'noisy' },
      workspace,
      notify,
    );
    await waitFor(() => sent().some((text) => text.includes('reason="too-many-events"')), 15_000);

    expect(sent().filter((text) => text.includes('<task-notification monitor-id=') && !text.includes('status=')).length).toBe(12);
  });

  it('sends nothing for a monitor the agent stopped', async () => {
    const { monitorId } = await runMonitor({ command: 'sleep 30', description: 'deploy' }, workspace, notify);

    expect(runMonitorStop({ monitorId })).toEqual({ ok: true });
    await waitFor(() => mocks.end.mock.calls.length > 0);
    expect(mocks.end).toHaveBeenCalledWith('monitor', monitorId);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(runMonitorStop({ monitorId })).toEqual({ ok: false });
  });

  it('keeps a monitor as pending work, with its process', async () => {
    const { monitorId } = await runMonitor({ command: 'sleep 30', description: 'deploy' }, workspace, notify);

    expect(mocks.begin).toHaveBeenCalledWith('monitor', monitorId, { description: 'deploy', notify });
    expect(mocks.update).toHaveBeenCalledWith('monitor', monitorId, {
      description: 'deploy',
      notify,
      process: expect.objectContaining({ pid: expect.any(Number) }),
    });
  });

  it('runs at most a few monitors at once', async () => {
    for (let i = 0; i < MAX_MONITORS; i++) await runMonitor({ command: 'sleep 30', description: `m${i}` }, workspace, notify);

    await expect(runMonitor({ command: 'sleep 30', description: 'one more' }, workspace, notify)).rejects.toThrow(
      `At most ${MAX_MONITORS} monitors run at once`,
    );
  });

  it('tells the conversation of a monitor a restart stopped that its watch ended, once', async () => {
    const mark = { pid: 4242, startedAt: 1_000 };
    await getMonitorManager().resume([
      { key: 'monitor-1', payload: { description: 'deploy', notify, process: mark, events: 3 }, attempts: 1, createdAt: new Date() } as never,
    ]);

    expect(mocks.stopLeftover).toHaveBeenCalledWith(mark);
    expect(sent()[0]).toContain('<task-notification monitor-id="monitor-1" description="deploy" status="ended" reason="restart" events="3">');
    // Under the monitor's id: a notice already stored is not stored again.
    expect(mocks.deliver).toHaveBeenCalledWith(notify, 'monitor-1', expect.any(String));
    expect(mocks.end).toHaveBeenCalledWith('monitor', 'monitor-1');
  });

  it('stores the last notice under the monitor id, and keeps the event count in its row', async () => {
    const { monitorId } = await runMonitor({ command: 'echo one; sleep 0.5; exit 0', description: 'job' }, workspace, notify);
    await waitFor(() => sent().length === 2);

    const [event, end] = mocks.deliver.mock.calls as unknown as [unknown, string, string][];
    expect(event[1]).not.toBe(monitorId);
    expect(end[1]).toBe(monitorId);
    expect(mocks.update).toHaveBeenCalledWith('monitor', monitorId, expect.objectContaining({ events: 1 }));
  });

  it('sends events while a command keeps printing, without waiting for a pause', async () => {
    await runMonitor(
      { command: 'for i in $(seq 1 15); do echo "line $i"; sleep 0.1; done; sleep 30', description: 'steady' },
      workspace,
      notify,
    );
    await waitFor(() => sent().length >= 3, 5_000);

    expect(sent().join('\n')).toContain('line 1\n');
  });

  it('keeps at most a line of output that has no newline yet', async () => {
    await runMonitor(
      { command: 'head -c 100000 /dev/zero | tr "\\0" x; sleep 30', description: 'meter' },
      workspace,
      notify,
    );
    const monitors = (getMonitorManager() as unknown as { monitors: Map<string, { partial: string }> }).monitors;
    const partial = () => [...monitors.values()][0]?.partial.length ?? 0;
    await waitFor(() => partial() > 0);
    await new Promise((r) => setTimeout(r, 300));

    expect(partial()).toBeLessThanOrEqual(2_001);
  });

  it('reads stderr, so a command that writes a lot to it keeps printing', async () => {
    await runMonitor({ command: 'head -c 300000 /dev/zero >&2; echo done; sleep 30', description: 'chatty' }, workspace, notify);
    await waitFor(() => sent().length === 1);

    expect(sent()[0]).toContain('\ndone\n');
  });

  it('kills a command that ignores SIGTERM', async () => {
    await runMonitor({ command: "trap '' TERM; sleep 30", description: 'stubborn', timeoutMs: 1_000 }, workspace, notify);
    await waitFor(() => sent().length === 1, 8_000);

    expect(sent()[0]).toContain('reason="timeout"');
    expect(getMonitorManager().runningCount()).toBe(0);
  });

  it('sends nothing a background child prints after the watch ended', async () => {
    await runMonitor({ command: '(sleep 2; echo late) & echo first', description: 'job' }, workspace, notify);
    await waitFor(() => sent().some((text) => text.includes('status="ended"')));
    await new Promise((r) => setTimeout(r, 2_500));

    expect(sent()).toHaveLength(2);
    expect(sent().join('\n')).not.toContain('late');
  });

  it('counts a start that waits for its row against the limit', async () => {
    const starts = Array.from({ length: MAX_MONITORS + 1 }, (_, i) =>
      runMonitor({ command: 'sleep 30', description: `m${i}` }, workspace, notify),
    );
    const results = await Promise.allSettled(starts);

    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(getMonitorManager().runningCount()).toBe(MAX_MONITORS);
  });
});
