/**
 * Self-update, in one of two modes.
 *
 * Both check the GHCR tag list for a newer release (hourly, first check one
 * minute after boot) and act only while the agent is idle. `install` (a SEA
 * binary) announces the release and applies it: stage + verify the release
 * archive, record a PENDING attempt, swap the install and restart. `exit`
 * (a container with EXIT_ON_UPDATE) waits a random delay, records a
 * PENDING attempt and stops, and the platform starts the new image. The next
 * boot resolves the pending attempt by comparing its own version to the
 * target — the record survives the process the update kills.
 *
 * The updater runs only where the baked version is release-shaped (a dev
 * build has nothing to compare), DISABLE_UPDATER is not set, and the process
 * is a SEA binary or a container with EXIT_ON_UPDATE. Clients see only
 * the `install` mode: in `exit` mode the status reports the updater off
 * and nothing is broadcast. Check failures are logged at debug and never
 * surface in any UI.
 *
 * Nothing here knows about WebSockets — progress is announced on the
 * `events` emitter (`'update'`, an {@link UpdateEvent}); the gateway
 * subscribes and broadcasts.
 */

import { EventEmitter } from 'node:events';
import sea from 'node:sea';
import { UpdateAttempt, UpdateOutcome, UpdateTrigger } from '@prisma/client';
import { config } from '../../config';
import {
  RELEASE_VERSION_RE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_RESTART_JITTER_MAX_MS,
  WINDOWS_HANDOFF_TIMEOUT_MS,
} from '../../constants';
import { logger } from '../../logger';
import { prisma } from '../../lib/prisma';
import { trackEvent } from '../../lib/telemetry';
import { agentStatusService } from '../agent-status.service';
import { compactionService } from '../compaction.service';
import { cronSchedulerService } from '../cron-scheduler.service';
import { goalService } from '../goal.service';
import { meetingBotService } from '../meeting/meeting-bot.service';
import { threadTurnService } from '../thread-turn.service';
import { compareReleaseVersions, fetchLatestReleaseVersion } from './ghcr';
import {
  removeStagedRelease,
  spawnWindowsInstaller,
  stageRelease,
  swapInstall,
  sweepUpdateDirs,
  UpdateError,
} from './apply';

export type UpdateDisabledReason = 'disabled_by_env' | 'not_sea_install' | 'dev_build';

/** How this process takes a newer release: swap the SEA install, or stop for the platform. */
export type UpdateMode = 'install' | 'exit';

/** A second apply was requested while one is running — the route maps it to 409. */
export class UpdateInProgressError extends Error {
  constructor() {
    super('An update is already in progress.');
    this.name = 'UpdateInProgressError';
  }
}

/** Emitted as `'update'` on `events`; broadcast to clients verbatim. */
export interface UpdateEvent {
  status: 'available' | 'updating' | 'failed';
  version: string;
  errorCode?: string;
}

export interface UpdateStatusReport {
  enabled: boolean;
  reason: UpdateDisabledReason | null;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  applying: boolean;
  lastAttempt: {
    versionFrom: string;
    versionTo: string;
    trigger: UpdateTrigger;
    outcome: UpdateOutcome;
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}

class UpdateService {
  readonly events = new EventEmitter();

  private latestVersion: string | null = null;
  private checkedAt: Date | null = null;
  private applying = false;
  /** Versions already announced, so 'available' fires once per version. */
  private announced = new Set<string>();
  private firstCheckTimer: NodeJS.Timeout | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  /** `exit` mode: the random delay between finding a release and stopping. */
  private exitTimer: NodeJS.Timeout | null = null;
  /** Set by `stop()`: a shutdown has started, so a restart past its delay ends. */
  private stopped = false;

  get gate(): { mode: UpdateMode | null; reason: UpdateDisabledReason | null } {
    if (config.disableUpdater) return { mode: null, reason: 'disabled_by_env' };
    if (!sea.isSea() && !config.exitOnUpdate) return { mode: null, reason: 'not_sea_install' };
    if (!RELEASE_VERSION_RE.test(config.appVersion)) return { mode: null, reason: 'dev_build' };
    return { mode: sea.isSea() ? 'install' : 'exit', reason: null };
  }

  /**
   * Boot entry: resolve attempts left pending by a previous process (the
   * restart sentinel), then start the check loop when the gate allows it.
   */
  async start(): Promise<void> {
    // Both of these belong to the installed binary, not to whatever process
    // happens to open the database. A source run shares ~/.prism/agent.db with
    // an install, and resolving there would mark that install's in-flight
    // attempt `restart_version_mismatch` while it is still mid-restart —
    // sweeping there would delete its staged release. A release container that
    // opted into EXIT_ON_UPDATE owns its /data, so it resolves too, and
    // never sweeps. Deliberately gated on the install shape rather than the
    // full gate: the process that comes back after an update is the one that
    // must resolve the sentinel, even if the user set DISABLE_UPDATER in between.
    const exitInstall = config.exitOnUpdate && RELEASE_VERSION_RE.test(config.appVersion);
    if (sea.isSea() || exitInstall) await this.resolvePendingAttempts();
    if (sea.isSea()) sweepUpdateDirs();

    const { mode, reason } = this.gate;
    if (mode === null) {
      logger.info(`[Update] updater off (${reason})`);
      return;
    }

    this.firstCheckTimer = setTimeout(() => void this.checkTick(), UPDATE_FIRST_CHECK_DELAY_MS);
    this.checkInterval = setInterval(() => void this.checkTick(), UPDATE_CHECK_INTERVAL_MS);
    logger.info(
      mode === 'install'
        ? `[Update] updater on — running ${config.appVersion}, checking hourly`
        : `[Update] EXIT_ON_UPDATE set — running ${config.appVersion}, checking hourly`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer);
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.firstCheckTimer = null;
    this.checkInterval = null;
    this.exitTimer = null;
  }

  /**
   * A container reports the same off state with or without EXIT_ON_UPDATE:
   * the platform, not a client, applies the release, so no client offers an
   * update and the manual route refuses one.
   */
  async getStatus(): Promise<UpdateStatusReport> {
    const { mode, reason } = this.gate;
    const enabled = mode === 'install';
    const last = await prisma.updateAttempt.findFirst({ orderBy: { startedAt: 'desc' } });
    return {
      enabled,
      reason: sea.isSea() || config.disableUpdater ? reason : 'not_sea_install',
      currentVersion: config.appVersion,
      latestVersion: this.latestVersion,
      updateAvailable: enabled && this.hasNewerVersion(),
      checkedAt: this.checkedAt?.toISOString() ?? null,
      applying: this.applying,
      lastAttempt: last ? toAttemptReport(last) : null,
    };
  }

  /**
   * One check against the registry. Updates the cached latest version;
   * returns it, or null when the check could not complete (already logged
   * at debug by the fetcher).
   */
  async checkNow(): Promise<string | null> {
    const latest = await fetchLatestReleaseVersion();
    if (latest === null) return null;
    this.latestVersion = latest;
    this.checkedAt = new Date();
    return latest;
  }

  /**
   * The synchronous half of an apply: claim the single-flight flag and
   * persist the attempt row, so the caller can acknowledge the update before
   * the download starts knowing its outcome is recorded either way. Returns
   * the running `completion` — {@link continueApply}, already started.
   * Throws {@link UpdateInProgressError} when an apply is already running,
   * or the row-insert failure with the flag released.
   */
  async startApply(
    version: string,
    trigger: UpdateTrigger,
  ): Promise<{ version: string; completion: Promise<{ version: string; willExit: boolean; deferred?: boolean }> }> {
    if (this.applying) throw new UpdateInProgressError();
    this.applying = true;

    let attempt: UpdateAttempt;
    try {
      attempt = await prisma.updateAttempt.create({
        data: { versionFrom: config.appVersion, versionTo: version, trigger },
      });
    } catch (error: unknown) {
      // A failed insert must not leave the single-flight flag stuck true —
      // that would block every later attempt until a restart.
      this.applying = false;
      throw error;
    }
    logger.info(`[Update] applying ${config.appVersion} -> ${version} (${trigger})`);
    return { version, completion: this.continueApply(attempt, version, trigger) };
  }

  /**
   * Stage, verify and activate `version`. Resolves after the point of no
   * return: on macOS/Linux the swap is done and the caller must end the
   * process (`willExit: true`); on Windows the staged installer now owns the
   * restart and will kill this process (`willExit: false`). An automatic
   * apply re-checks the idle gate after the download — staging can take
   * minutes, and work that started meanwhile must not be restarted under —
   * and defers (`deferred: true`, staged files kept for cheap reuse) when the
   * agent turned busy. Rejects before anything was activated — the install is
   * untouched and `applying` is released.
   */
  async applyUpdate(
    version: string,
    trigger: UpdateTrigger,
  ): Promise<{ version: string; willExit: boolean; deferred?: boolean }> {
    const { completion } = await this.startApply(version, trigger);
    return completion;
  }

  private async continueApply(
    attempt: UpdateAttempt,
    version: string,
    trigger: UpdateTrigger,
  ): Promise<{ version: string; willExit: boolean; deferred?: boolean }> {
    let updatingEmitted = false;
    try {
      const distDir = await stageRelease(version);

      // Named trade: this narrows the window, it does not close it. A message
      // landing between this check and the exit — the swap, the 500 ms flush
      // delay, then a graceful shutdown, so roughly one to six seconds — still
      // starts a turn the restart kills mid-stream, and the user sees neither
      // a reply nor a reason. Closing it needs the thread service to refuse
      // new claims for the rest of the process's life, which is a lock with
      // its own failure mode (an update that then fails leaves the agent
      // mute). A seconds-wide window on an hourly check is the cheaper side.
      if (trigger === 'AUTO' && !(await this.isIdle())) {
        // Not an attempt that failed — one that never activated. Drop the
        // row, keep the verified stage, and let the next tick retry.
        await prisma.updateAttempt.delete({ where: { id: attempt.id } });
        this.applying = false;
        logger.info(`[Update] ${version} staged but the agent turned busy — deferring activation`);
        return { version, willExit: false, deferred: true };
      }

      this.events.emit('update', { status: 'updating', version } satisfies UpdateEvent);
      updatingEmitted = true;
      if (process.platform === 'win32') {
        await spawnWindowsInstaller(distDir, version);
        this.armWindowsHandoffWatchdog(attempt, version);
        return { version, willExit: false };
      }
      swapInstall(distDir);
      return { version, willExit: true };
    } catch (error: unknown) {
      const errorCode = error instanceof UpdateError ? error.code : 'apply_failed';
      const errorDetail = error instanceof Error ? error.message : String(error);
      try {
        // Its own try: the two failures are correlated rather than
        // independent — a full disk fails the staging with ENOSPC and this
        // write with SQLITE_FULL — and that is exactly when the staged files
        // most need deleting and the UI most needs telling. A row left
        // PENDING here would also resolve SUCCESS at the next boot alongside
        // a later real attempt, double-counting `update applied`.
        await this.finishAttempt(attempt, 'FAILURE', errorCode, errorDetail);
      } catch (recordError: unknown) {
        logger.error({ err: recordError }, '[Update] could not record the failed attempt');
      } finally {
        // Don't leave a few hundred MB staged until the next boot's sweep —
        // an always-on daemon can run for weeks.
        removeStagedRelease(version);
        // A manual failure is always reported. An automatic one is reported
        // only after 'updating' already went out — every 'updating' frame
        // must end in a restart or a 'failed', or the UIs stick on
        // "updating…".
        if (trigger === 'MANUAL' || updatingEmitted) {
          this.events.emit('update', { status: 'failed', version, errorCode } satisfies UpdateEvent);
        }
        // Released even when recording the failure throws (a transient DB
        // error must not block every later attempt until a restart).
        this.applying = false;
      }
      throw error;
    }
    // `applying` intentionally stays true on success — this process is over.
  }

  /**
   * End this process so the supervisor (launchd KeepAlive / systemd
   * Restart=always) respawns the swapped-in binary, or the container platform
   * starts the new image. The delay lets the WS broadcast and any HTTP
   * response flush first.
   *
   * Raises SIGTERM rather than exiting outright, so the restart runs the same
   * graceful shutdown a `docker stop` gets: plugin MCP child processes closed
   * instead of orphaned, a live meeting left rather than frozen in the room,
   * channels disconnected, and telemetry flushed.
   */
  scheduleRestartExit(delayMs = 500): void {
    logger.info('[Update] restarting to finish the update');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), delayMs);
  }

  private hasNewerVersion(): boolean {
    return (
      this.gate.mode !== null &&
      this.latestVersion !== null &&
      compareReleaseVersions(this.latestVersion, config.appVersion) > 0
    );
  }

  /**
   * The hourly tick: check, announce once per version, and auto-apply (or,
   * in `restart` mode, arm the delayed stop) when nothing is mid-flight. A
   * busy agent (LLM turn, running cron task, live goal loop, live meeting)
   * defers to the next tick rather than being restarted under a turn.
   */
  private async checkTick(): Promise<void> {
    if (this.applying) return;
    const latest = await this.checkNow();
    if (latest === null || !this.hasNewerVersion()) return;
    const mode = this.gate.mode;

    // Announced on every tick, not once: a client that connects after the
    // first announce (the TUI has no status fetch) still learns about it on
    // the next tick, and both consumers render the frame idempotently. Only
    // the telemetry event is once-per-version. `restart` mode sends no frame,
    // since every client would offer an update this install cannot install.
    if (mode === 'install') {
      this.events.emit('update', { status: 'available', version: latest } satisfies UpdateEvent);
    }
    if (!this.announced.has(latest)) {
      this.announced.add(latest);
      logger.info(`[Update] ${latest} is available (running ${config.appVersion})`);
      trackEvent('update available', config.ownerUserId, {
        version_from: config.appVersion,
        version_to: latest,
      });
    }

    if (!(await this.isIdle())) {
      logger.info(`[Update] ${latest} not applied — agent busy, retrying next tick`);
      return;
    }
    if (mode === 'exit') {
      await this.armExit(latest);
      return;
    }
    try {
      const { willExit, deferred } = await this.applyUpdate(latest, 'AUTO');
      if (deferred) return;
      if (willExit) this.scheduleRestartExit();
    } catch (error: unknown) {
      logger.warn(
        `[Update] automatic update to ${latest} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `restart` mode: stop after a random delay of up to
   * {@link UPDATE_RESTART_JITTER_MAX_MS}, so a fleet that finds a release in
   * the same minute does not stop in the same minute.
   *
   * Skipped for a version whose earlier restart came back on the old version
   * (`restart_version_mismatch`): that platform restarts the same image, and
   * a stop on every boot would loop without end. The next release tries again.
   */
  private async armExit(version: string): Promise<void> {
    const failed = await prisma.updateAttempt.findFirst({
      where: { versionTo: version, outcome: 'FAILURE', errorCode: 'restart_version_mismatch' },
    });
    if (failed) {
      logger.debug(`[Update] ${version} not applied — an earlier restart came back on ${failed.versionFrom}`);
      return;
    }

    const delayMs = Math.floor(Math.random() * UPDATE_RESTART_JITTER_MAX_MS);
    logger.info(`[Update] stopping for ${version} in ${Math.round(delayMs / 1000)} s if the agent is idle then`);
    this.exitTimer = setTimeout(() => void this.exitForRelease(version), delayMs);
  }

  /**
   * The end of the delay: re-check the idle gate, since work can start during
   * the delay, then record the attempt and stop. A busy agent waits for the
   * next tick, which draws a new delay.
   */
  private async exitForRelease(version: string): Promise<void> {
    this.exitTimer = null;
    const idle = await this.isIdle();
    if (this.stopped) return;
    if (!idle) {
      logger.info(`[Update] ${version} not applied — agent busy after the delay, retrying next tick`);
      return;
    }
    try {
      await prisma.updateAttempt.create({
        data: { versionFrom: config.appVersion, versionTo: version, trigger: 'AUTO' },
      });
    } catch (error: unknown) {
      logger.warn({ err: error }, `[Update] could not record the restart for ${version} — retrying next tick`);
      return;
    }
    if (this.stopped) return;
    // Stays true: this process is over.
    this.applying = true;
    logger.info(`[Update] stopping for ${version} (running ${config.appVersion})`);
    this.scheduleRestartExit();
  }

  /**
   * Windows only: the staged installer is supposed to kill this process, so
   * reaching the deadline means it did not. Nothing else would notice — the
   * Unix path has a supervisor, this one has the installer and nothing more —
   * and the attempt would stay PENDING with `applying` stuck true, so no
   * later tick ever retries.
   */
  private armWindowsHandoffWatchdog(attempt: UpdateAttempt, version: string): void {
    const timer = setTimeout(() => {
      void (async () => {
        logger.warn(
          `[Update] the installer for ${version} did not restart this process within ` +
            `${WINDOWS_HANDOFF_TIMEOUT_MS / 60_000} minutes — marking the attempt failed`,
        );
        try {
          await this.finishAttempt(attempt, 'FAILURE', 'handoff_timeout', null);
        } catch (error: unknown) {
          logger.error({ err: error }, '[Update] could not record the handoff timeout');
        } finally {
          this.events.emit('update', {
            status: 'failed',
            version,
            errorCode: 'handoff_timeout',
          } satisfies UpdateEvent);
          this.applying = false;
        }
      })();
    }, WINDOWS_HANDOFF_TIMEOUT_MS);
    // Never hold the process open for it: if the installer does its job, this
    // process is killed long before the deadline.
    timer.unref();
  }

  /**
   * Whether nothing is in flight that a restart would interrupt.
   *
   * `isBusy()` counts model invocations, which is not the same as "the agent
   * has nothing running". Two kinds of work outlive the turn that started it,
   * and both would die unannounced in a restart:
   *
   * - a chat exchange, which spans the gap between a turn and the follow-up
   *   coalesced after it, and holds its claim across that gap;
   * - a `shell_spawn` child or a `coding_agent` task, started by one tool call
   *   and polled from later turns — killing one leaves the agent's next status
   *   poll with nothing to report.
   */
  private async isIdle(): Promise<boolean> {
    if (
      agentStatusService.isBusy() ||
      threadTurnService.hasLiveExchange() ||
      meetingBotService.isActive ||
      cronSchedulerService.hasRunningTask() ||
      goalService.hasLiveLoops() ||
      compactionService.hasInFlight()
    ) {
      return false;
    }

    // Imported here rather than at the top: this service is reachable from the
    // WebSocket gateway, and the shell tool modules and the voice chat's tool
    // set have no business in that import graph. An updater that never runs
    // never loads them.
    const [{ getProcessManager }, { getAgentTaskManager }, { voiceChatService }] = await Promise.all([
      import('../../tools/shell/process-manager'),
      import('../../tools/shell/agent-task-manager'),
      import('../voice/voice-chat.service'),
    ]);
    return (
      getProcessManager().runningCount() === 0 &&
      getAgentTaskManager().runningCount() === 0 &&
      !voiceChatService.isLive
    );
  }

  /**
   * The boot half of the restart sentinel: every attempt still PENDING was
   * interrupted by its own handoff. It succeeded exactly when this process
   * runs the version it targeted.
   */
  private async resolvePendingAttempts(): Promise<void> {
    const pending = await prisma.updateAttempt.findMany({ where: { outcome: 'PENDING' } });
    for (const row of pending) {
      // A container restart runs whatever `latest` is at pull time, which can
      // be newer than the release the attempt recorded.
      const success =
        RELEASE_VERSION_RE.test(config.appVersion) && compareReleaseVersions(config.appVersion, row.versionTo) >= 0;
      await this.finishAttempt(row, success ? 'SUCCESS' : 'FAILURE', success ? null : 'restart_version_mismatch', null);
      if (success) {
        logger.info(`[Update] updated ${row.versionFrom} -> ${config.appVersion}`);
      } else {
        logger.warn(
          `[Update] update to ${row.versionTo} did not take — running ${config.appVersion || '<unversioned>'}`,
        );
      }
    }
  }

  private async finishAttempt(
    attempt: UpdateAttempt,
    outcome: 'SUCCESS' | 'FAILURE',
    errorCode: string | null,
    errorDetail: string | null,
  ): Promise<void> {
    await prisma.updateAttempt.update({
      where: { id: attempt.id },
      data: { outcome, errorCode, errorDetail, finishedAt: new Date() },
    });
    trackEvent('update applied', config.ownerUserId, {
      version_from: attempt.versionFrom,
      version_to: attempt.versionTo,
      outcome,
      trigger: attempt.trigger,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }
}

function toAttemptReport(row: UpdateAttempt): NonNullable<UpdateStatusReport['lastAttempt']> {
  return {
    versionFrom: row.versionFrom,
    versionTo: row.versionTo,
    trigger: row.trigger,
    outcome: row.outcome,
    errorCode: row.errorCode,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export const updateService = new UpdateService();
