/**
 * Update orchestrator tests: the gate matrix, the check loop (announce once,
 * defer while busy, auto-apply when idle), the restart sentinel, the failure
 * paths of applyUpdate, and the container restart on a new release.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../../config';
import { UpdateError } from '../apply';

const {
  mockPrisma,
  mockTrackEvent,
  mockFetchLatest,
  mockStage,
  mockSwap,
  mockSpawnWin,
  mockSweep,
  mockRemoveStaged,
  idleState,
} = vi.hoisted(() => ({
  mockPrisma: {
    updateAttempt: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
  mockFetchLatest: vi.fn(),
  mockStage: vi.fn(),
  mockSwap: vi.fn(),
  mockSpawnWin: vi.fn(),
  mockSweep: vi.fn(),
  mockRemoveStaged: vi.fn(),
  idleState: {
    busy: false,
    exchange: false,
    call: false,
    cron: false,
    goals: false,
    shellProcs: 0,
    agentTasks: 0,
    voiceChat: false,
    isSea: true,
  },
}));

vi.mock('../../../lib/prisma', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../../agent-status.service', () => ({
  agentStatusService: { isBusy: () => idleState.busy },
}));
vi.mock('../../cron-scheduler.service', () => ({
  cronSchedulerService: { hasRunningTask: () => idleState.cron },
}));
vi.mock('../../goal.service', () => ({
  goalService: { hasLiveLoops: () => idleState.goals },
}));
vi.mock('../../compaction.service', () => ({
  compactionService: { hasInFlight: () => false },
}));
vi.mock('../../thread-turn.service', () => ({
  threadTurnService: { hasLiveExchange: () => idleState.exchange },
}));
vi.mock('../../../tools/shell/process-manager', () => ({
  getProcessManager: () => ({ runningCount: () => idleState.shellProcs }),
}));
vi.mock('../../../tools/shell/agent-task-manager', () => ({
  getAgentTaskManager: () => ({ runningCount: () => idleState.agentTasks }),
}));
vi.mock('../../call/call.service', () => ({
  callService: {
    get isActive() {
      return idleState.call;
    },
  },
}));
vi.mock('../../voice/voice-chat.service', () => ({
  voiceChatService: {
    get isLive() {
      return idleState.voiceChat;
    },
  },
}));
vi.mock('node:sea', () => ({
  default: {
    isSea: () => idleState.isSea,
  },
}));
vi.mock('../ghcr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ghcr')>()),
  fetchLatestReleaseVersion: mockFetchLatest,
}));
vi.mock('../apply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apply')>()),
  stageRelease: mockStage,
  swapInstall: mockSwap,
  spawnWindowsInstaller: mockSpawnWin,
  sweepUpdateDirs: mockSweep,
  removeStagedRelease: mockRemoveStaged,
}));

const CURRENT = 'v2026.8.20000000';
const NEWER = 'v2026.8.24083158';

async function loadService() {
  vi.resetModules();
  const mod = await import('../update.service');
  return mod.updateService;
}

// The restart raises SIGTERM on this process so index.ts runs its graceful
// shutdown. Stubbed for every test, or a run that advances past the restart
// delay would kill the test worker.
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
  Object.assign(idleState, {
    busy: false,
    exchange: false,
    call: false,
    cron: false,
    goals: false,
    shellProcs: 0,
    agentTasks: 0,
    voiceChat: false,
    isSea: true,
  });
  config.appVersion = CURRENT;
  config.disableUpdater = false;
  config.exitOnUpdate = false;
  mockPrisma.updateAttempt.findMany.mockResolvedValue([]);
  mockPrisma.updateAttempt.findFirst.mockResolvedValue(null);
  mockPrisma.updateAttempt.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'attempt-1', outcome: 'PENDING', ...data }),
  );
  mockPrisma.updateAttempt.update.mockResolvedValue({});
  mockPrisma.updateAttempt.delete.mockResolvedValue({});
  mockStage.mockResolvedValue('/tmp/staged/dist');
});

afterEach(() => {
  config.appVersion = '';
  config.disableUpdater = false;
  config.exitOnUpdate = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gate', () => {
  it.each([
    ['not a SEA binary', { isSea: false }, 'not_sea_install'],
    ['a dev build', { appVersion: '0.1.0' }, 'dev_build'],
    ['DISABLE_UPDATER set', { disableUpdater: true }, 'disabled_by_env'],
  ])('is off for %s', async (_name, override, reason) => {
    if ('isSea' in override) idleState.isSea = override.isSea as boolean;
    if ('appVersion' in override) config.appVersion = override.appVersion as string;
    if ('disableUpdater' in override) config.disableUpdater = override.disableUpdater as boolean;

    const service = await loadService();
    const status = await service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe(reason);
  });

  it('is on for a SEA binary with a release version', async () => {
    const service = await loadService();
    await expect(service.getStatus()).resolves.toMatchObject({ enabled: true, reason: null });
  });
});

describe('start', () => {
  it('resolves pending rows and sweeps, but starts no loop, when disabled on a SEA install', async () => {
    config.disableUpdater = true;
    const service = await loadService();
    await service.start();
    expect(mockPrisma.updateAttempt.findMany).toHaveBeenCalledWith({ where: { outcome: 'PENDING' } });
    // Leftovers from before the updater was disabled still get swept.
    expect(mockSweep).toHaveBeenCalled();
    expect(mockFetchLatest).not.toHaveBeenCalled();
  });

  it('never sweeps on a non-SEA run (installRoot would be the Node binary dir)', async () => {
    idleState.isSea = false;
    const service = await loadService();
    await service.start();
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('marks a pending attempt SUCCESS when running the target version', async () => {
    config.appVersion = NEWER;
    mockPrisma.updateAttempt.findMany.mockResolvedValue([
      { id: 'a1', versionFrom: CURRENT, versionTo: NEWER, trigger: 'AUTO', outcome: 'PENDING' },
    ]);
    const service = await loadService();
    await service.start();
    service.stop();

    expect(mockPrisma.updateAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1' },
        data: expect.objectContaining({ outcome: 'SUCCESS', errorCode: null }),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith('update applied', config.ownerUserId, {
      version_from: CURRENT,
      version_to: NEWER,
      outcome: 'SUCCESS',
      trigger: 'AUTO',
    });
  });

  it('marks a pending attempt FAILURE when the version did not change', async () => {
    mockPrisma.updateAttempt.findMany.mockResolvedValue([
      { id: 'a1', versionFrom: CURRENT, versionTo: NEWER, trigger: 'MANUAL', outcome: 'PENDING' },
    ]);
    const service = await loadService();
    await service.start();
    service.stop();

    expect(mockPrisma.updateAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'FAILURE', errorCode: 'restart_version_mismatch' }),
      }),
    );
  });
});

describe('check loop', () => {
  it('announces every tick (telemetry once), defers while busy, applies when idle', async () => {
    vi.useFakeTimers();
    mockFetchLatest.mockResolvedValue(NEWER);
    idleState.busy = true;

    const service = await loadService();
    const events: Array<{ status: string; version: string }> = [];
    service.events.on('update', (e: { status: string; version: string }) => events.push(e));
    await service.start();

    // First tick: busy — announce, don't apply.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([{ status: 'available', version: NEWER }]);
    expect(mockTrackEvent).toHaveBeenCalledWith('update available', config.ownerUserId, {
      version_from: CURRENT,
      version_to: NEWER,
    });
    expect(mockStage).not.toHaveBeenCalled();

    // Second tick: still busy — re-announced (a client that connected after
    // the first tick has no other way to learn), telemetry not repeated.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(events).toEqual([
      { status: 'available', version: NEWER },
      { status: 'available', version: NEWER },
    ]);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);

    // Third tick: idle — stage, swap, restart.
    idleState.busy = false;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockStage).toHaveBeenCalledWith(NEWER);
    expect(mockSwap).toHaveBeenCalledWith('/tmp/staged/dist');
    expect(events).toContainEqual({ status: 'updating', version: NEWER });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    service.stop();
  });

  it('defers to a live exchange even when no model call is in flight', async () => {
    vi.useFakeTimers();
    mockFetchLatest.mockResolvedValue(NEWER);
    // The gap a single exchange spans: the claim is open and a follow-up is
    // queued, but no invocation is running, so isBusy() alone reads idle.
    idleState.busy = false;
    idleState.exchange = true;

    const service = await loadService();
    const events: Array<{ status: string }> = [];
    service.events.on('update', (e: { status: string }) => events.push(e));
    await service.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([{ status: 'available', version: NEWER }]);
    expect(mockStage).not.toHaveBeenCalled();

    // Exchange over — the next tick applies.
    idleState.exchange = false;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockStage).toHaveBeenCalledWith(NEWER);
    service.stop();
  });

  it.each([
    ['a shell_spawn child', 'shellProcs'],
    ['a coding_agent task', 'agentTasks'],
  ])('defers while %s is still running', async (_label, key) => {
    vi.useFakeTimers();
    mockFetchLatest.mockResolvedValue(NEWER);
    // Started by an earlier turn and polled from later ones: no model call is
    // in flight, but a restart would kill the child mid-flight.
    (idleState as Record<string, unknown>)[key] = 1;

    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockStage).not.toHaveBeenCalled();

    (idleState as Record<string, unknown>)[key] = 0;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockStage).toHaveBeenCalledWith(NEWER);
    service.stop();
  });

  it('defers while a voice chat is live', async () => {
    vi.useFakeTimers();
    mockFetchLatest.mockResolvedValue(NEWER);
    // A voice chat runs no model invocation of its own, so isBusy() reads idle
    // while the call is open.
    idleState.voiceChat = true;

    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockStage).not.toHaveBeenCalled();

    idleState.voiceChat = false;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockStage).toHaveBeenCalledWith(NEWER);
    service.stop();
  });

  it('does nothing when the registry has nothing newer', async () => {
    vi.useFakeTimers();
    mockFetchLatest.mockResolvedValue(CURRENT);
    const service = await loadService();
    const events: unknown[] = [];
    service.events.on('update', (e: unknown) => events.push(e));
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([]);
    expect(mockStage).not.toHaveBeenCalled();
    service.stop();
  });
});

describe('applyUpdate', () => {
  it('records the failure and frees the single-flight flag when staging fails', async () => {
    mockStage.mockRejectedValue(new UpdateError('asset_not_found', 'not published yet'));
    const service = await loadService();
    const events: Array<{ status: string; errorCode?: string }> = [];
    service.events.on('update', (e: { status: string; errorCode?: string }) => events.push(e));

    await expect(service.applyUpdate(NEWER, 'MANUAL')).rejects.toThrow('not published yet');

    expect(mockPrisma.updateAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ outcome: 'FAILURE', errorCode: 'asset_not_found' }),
      }),
    );
    // A manual failure is reported; the staged download is removed; the flag
    // is free for the next attempt.
    expect(events).toContainEqual({ status: 'failed', version: NEWER, errorCode: 'asset_not_found' });
    expect(mockRemoveStaged).toHaveBeenCalledWith(NEWER);
    await expect(service.getStatus()).resolves.toMatchObject({ applying: false });
  });

  it('frees the single-flight flag when the attempt row cannot be written', async () => {
    mockPrisma.updateAttempt.create.mockRejectedValueOnce(new Error('database is locked'));
    const service = await loadService();
    await expect(service.applyUpdate(NEWER, 'MANUAL')).rejects.toThrow('locked');
    await expect(service.getStatus()).resolves.toMatchObject({ applying: false });
    expect(mockStage).not.toHaveBeenCalled();
  });

  it('stays silent on an automatic failure', async () => {
    mockStage.mockRejectedValue(new UpdateError('download_failed', 'boom'));
    const service = await loadService();
    const events: Array<{ status: string }> = [];
    service.events.on('update', (e: { status: string }) => events.push(e));

    await expect(service.applyUpdate(NEWER, 'AUTO')).rejects.toThrow('boom');
    expect(events.filter((e) => e.status === 'failed')).toEqual([]);
  });

  it('defers an automatic activation when the agent turned busy during the download', async () => {
    const service = await loadService();
    const events: unknown[] = [];
    service.events.on('update', (e: unknown) => events.push(e));
    // Idle when the tick gated, busy by the time staging finished.
    mockStage.mockImplementation(async () => {
      idleState.busy = true;
      return '/tmp/staged/dist';
    });

    await expect(service.applyUpdate(NEWER, 'AUTO')).resolves.toEqual({
      version: NEWER,
      willExit: false,
      deferred: true,
    });
    // Not an attempt: the row is dropped, nothing activated, nothing said.
    expect(mockPrisma.updateAttempt.delete).toHaveBeenCalledWith({ where: { id: 'attempt-1' } });
    expect(mockSwap).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await expect(service.getStatus()).resolves.toMatchObject({ applying: false });
  });

  it("reports an automatic failure that happens after 'updating' went out", async () => {
    mockSwap.mockImplementationOnce(() => {
      throw new UpdateError('swap_failed', 'disk full');
    });
    const service = await loadService();
    const events: Array<{ status: string }> = [];
    service.events.on('update', (e: { status: string }) => events.push(e));

    await expect(service.applyUpdate(NEWER, 'AUTO')).rejects.toThrow('disk full');
    // Every 'updating' frame must end in a restart or a 'failed' — the UIs
    // stick on "updating…" otherwise.
    expect(events.map((e) => e.status)).toEqual(['updating', 'failed']);
  });

  it('fails the attempt when the Windows installer never restarts this process', async () => {
    vi.useFakeTimers();
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const service = await loadService();
      const events: Array<{ status: string; errorCode?: string }> = [];
      service.events.on('update', (e: { status: string; errorCode?: string }) => events.push(e));

      await expect(service.applyUpdate(NEWER, 'MANUAL')).resolves.toMatchObject({ willExit: false });
      // The installer owns the restart from here; nothing else would notice
      // that it died, so `applying` would otherwise stay true forever.
      await expect(service.getStatus()).resolves.toMatchObject({ applying: true });

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      expect(mockPrisma.updateAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ outcome: 'FAILURE', errorCode: 'handoff_timeout' }),
        }),
      );
      expect(events).toContainEqual({
        status: 'failed',
        version: NEWER,
        errorCode: 'handoff_timeout',
      });
      await expect(service.getStatus()).resolves.toMatchObject({ applying: false });
      service.stop();
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });

  it('keeps applying=true after a successful swap (the process is about to exit)', async () => {
    const service = await loadService();
    await expect(service.applyUpdate(NEWER, 'MANUAL')).resolves.toEqual({
      version: NEWER,
      willExit: true,
    });
    await expect(service.getStatus()).resolves.toMatchObject({ applying: true });
    await expect(service.applyUpdate(NEWER, 'MANUAL')).rejects.toThrow('already in progress');
  });
});

describe('exit on update', () => {
  const HOUR = 60 * 60_000;

  beforeEach(() => {
    idleState.isSea = false;
    config.exitOnUpdate = true;
    mockFetchLatest.mockResolvedValue(NEWER);
  });

  it('reports the updater off to clients', async () => {
    vi.useFakeTimers();
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // The platform applies the release, so no client offers an update and the
    // manual route refuses one.
    await expect(service.getStatus()).resolves.toMatchObject({
      enabled: false,
      reason: 'not_sea_install',
      latestVersion: NEWER,
      updateAvailable: false,
    });
    service.stop();
  });

  it.each([
    ['the setting is off', () => (config.exitOnUpdate = false)],
    ['the image is a canary build', () => (config.appVersion = 'canary-abc123')],
    ['the image is a pull-request build', () => (config.appVersion = 'pr-42-some-branch')],
    ['DISABLE_UPDATER is set', () => (config.disableUpdater = true)],
  ])('never checks when %s', async (_name, apply) => {
    vi.useFakeTimers();
    apply();
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(mockFetchLatest).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    service.stop();
  });

  it('leaves a SEA binary on the install path', async () => {
    vi.useFakeTimers();
    idleState.isSea = true;
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockStage).toHaveBeenCalledWith(NEWER);
    expect(mockSwap).toHaveBeenCalledWith('/tmp/staged/dist');
    service.stop();
  });

  it('stops after the random delay, with no download and no frame', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const service = await loadService();
    const events: unknown[] = [];
    service.events.on('update', (e: unknown) => events.push(e));
    await service.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockTrackEvent).toHaveBeenCalledWith('update available', config.ownerUserId, {
      version_from: CURRENT,
      version_to: NEWER,
    });
    expect(mockPrisma.updateAttempt.create).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    // Half of the 30-minute bound, then the 500 ms exit delay.
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 500);
    expect(mockPrisma.updateAttempt.create).toHaveBeenCalledWith({
      data: { versionFrom: CURRENT, versionTo: NEWER, trigger: 'AUTO' },
    });
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(mockStage).not.toHaveBeenCalled();
    expect(mockSwap).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    service.stop();
  });

  it('stops before the next check at the largest delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000 + 30 * 60_000 + 500);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(mockFetchLatest).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('waits for the next check when work starts during the delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const service = await loadService();
    await service.start();

    // Idle at the check, so the delay starts; busy when it ends.
    await vi.advanceTimersByTimeAsync(60_000);
    idleState.voiceChat = true;
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 500);
    expect(mockPrisma.updateAttempt.create).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    idleState.voiceChat = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockPrisma.updateAttempt.create).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    service.stop();
  });

  it('waits for the next check when the agent is busy at the check', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    idleState.busy = true;
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000 + 30 * 60_000);
    expect(killSpy).not.toHaveBeenCalled();

    idleState.busy = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    service.stop();
  });

  it('cancels the pending stop on stop()', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    service.stop();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(mockPrisma.updateAttempt.create).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('records nothing when a shutdown starts while the delay ends', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const service = await loadService();
    // The second idle check is the re-check after the delay: stop() lands
    // while it is in flight, as a SIGTERM from the platform would.
    let reads = 0;
    Object.defineProperty(idleState, 'voiceChat', {
      configurable: true,
      get: () => {
        if (++reads === 2) service.stop();
        return false;
      },
    });
    try {
      await service.start();
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      expect(reads).toBe(2);
      expect(mockPrisma.updateAttempt.create).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(idleState, 'voiceChat', { configurable: true, writable: true, value: false });
    }
  });

  it.each([
    ['blocks', NEWER, false],
    ['ignores a failure for another version', 'v2026.8.21000000', true],
  ])('%s a restart that came back on the old version', async (_name, failedVersion, restarts) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockPrisma.updateAttempt.findFirst.mockImplementation(
      (args: { where?: { versionTo: string; outcome: string; errorCode: string } }) => {
        const w = args.where;
        const match =
          w?.versionTo === failedVersion &&
          w.outcome === 'FAILURE' &&
          w.errorCode === 'restart_version_mismatch';
        return Promise.resolve(match ? { id: 'a0', versionFrom: CURRENT, versionTo: failedVersion } : null);
      },
    );
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(killSpy.mock.calls.length > 0).toBe(restarts);
    service.stop();
  });

  it('does not stop when the attempt row cannot be written, and retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockPrisma.updateAttempt.create.mockRejectedValueOnce(new Error('database is locked'));
    const service = await loadService();
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000 + 500);
    expect(killSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(mockPrisma.updateAttempt.create).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    service.stop();
  });

  it.each([
    ['SUCCESS on the target version', NEWER, { outcome: 'SUCCESS', errorCode: null }],
    ['SUCCESS on a release newer than the target', 'v2026.8.25000000', { outcome: 'SUCCESS', errorCode: null }],
    ['FAILURE on the old version', CURRENT, { outcome: 'FAILURE', errorCode: 'restart_version_mismatch' }],
  ])('resolves the pending attempt at boot: %s', async (_name, bootVersion, expected) => {
    config.appVersion = bootVersion;
    mockPrisma.updateAttempt.findMany.mockResolvedValue([
      { id: 'a1', versionFrom: CURRENT, versionTo: NEWER, trigger: 'AUTO', outcome: 'PENDING' },
    ]);
    const service = await loadService();
    await service.start();
    service.stop();
    expect(mockPrisma.updateAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a1' }, data: expect.objectContaining(expected) }),
    );
    expect(mockSweep).not.toHaveBeenCalled();
  });
});
