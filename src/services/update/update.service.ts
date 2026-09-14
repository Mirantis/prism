/**
 * Self-update for standalone (SEA) installs.
 *
 * Checks the GHCR tag list for a newer release (hourly, first check one
 * minute after boot), announces it, and applies it: stage + verify the
 * release archive, record a PENDING attempt, swap the install and restart.
 * The next boot resolves the pending attempt by comparing its own version to
 * the target — the record survives the process the update kills.
 *
 * The updater runs only where all three hold: the process is a SEA binary
 * (a container or dev run updates by other means — pulling the image, git),
 * its baked version is release-shaped (a dev build has nothing to compare),
 * and DISABLE_UPDATER is not set. Check failures are logged at debug and
 * never surface in any UI.
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
  WINDOWS_HANDOFF_TIMEOUT_MS,
} from '../../constants';
import { logger } from '../../logger';
import { prisma } from '../../lib/prisma';
import { isRuntimeIdle } from '../../lib/runtime-idle';
import { trackEvent } from '../../lib/telemetry';
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

  get gate(): { enabled: boolean; reason: UpdateDisabledReason | null } {
    if (config.disableUpdater) return { enabled: false, reason: 'disabled_by_env' };
    if (!sea.isSea()) return { enabled: false, reason: 'not_sea_install' };
    if (!RELEASE_VERSION_RE.test(config.appVersion)) return { enabled: false, reason: 'dev_build' };
    return { enabled: true, reason: null };
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
    // sweeping there would delete its staged release. Deliberately gated on
    // `sea.isSea()` alone rather than the full gate: the process that comes
    // back after an update is the one that must resolve the sentinel, even if
    // the user set DISABLE_UPDATER in between.
    if (sea.isSea()) {
      await this.resolvePendingAttempts();
      sweepUpdateDirs();
    }

    const { enabled, reason } = this.gate;
    if (!enabled) {
      logger.info(`[Update] updater off (${reason})`);
      return;
    }

    this.firstCheckTimer = setTimeout(() => void this.checkTick(), UPDATE_FIRST_CHECK_DELAY_MS);
    this.checkInterval = setInterval(() => void this.checkTick(), UPDATE_CHECK_INTERVAL_MS);
    logger.info(`[Update] updater on — running ${config.appVersion}, checking hourly`);
  }

  stop(): void {
    if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer);
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.firstCheckTimer = null;
    this.checkInterval = null;
  }

  async getStatus(): Promise<UpdateStatusReport> {
    const { enabled, reason } = this.gate;
    const last = await prisma.updateAttempt.findFirst({ orderBy: { startedAt: 'desc' } });
    return {
      enabled,
      reason,
      currentVersion: config.appVersion,
      latestVersion: this.latestVersion,
      updateAvailable: this.hasNewerVersion(),
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
   * Restart=always) respawns the swapped-in binary. The delay lets the WS
   * broadcast and any HTTP response flush first.
   *
   * Raises SIGTERM rather than exiting outright, so the restart runs the same
   * graceful shutdown a `docker stop` gets: plugin MCP child processes closed
   * instead of orphaned, a live meeting left rather than frozen in the room,
   * Slack disconnected, and telemetry flushed.
   */
  scheduleRestartExit(delayMs = 500): void {
    logger.info('[Update] restarting to finish the update');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), delayMs);
  }

  private hasNewerVersion(): boolean {
    return (
      this.gate.enabled &&
      this.latestVersion !== null &&
      compareReleaseVersions(this.latestVersion, config.appVersion) > 0
    );
  }

  /**
   * The hourly tick: check, announce once per version, and auto-apply when
   * nothing is mid-flight. A busy agent (LLM turn, running cron task, live
   * goal loop, live meeting) defers to the next tick rather than being
   * restarted under a turn.
   */
  private async checkTick(): Promise<void> {
    if (this.applying) return;
    const latest = await this.checkNow();
    if (latest === null || !this.hasNewerVersion()) return;

    // Announced on every tick, not once: a client that connects after the
    // first announce (the TUI has no status fetch) still learns about it on
    // the next tick, and both consumers render the frame idempotently. Only
    // the telemetry event is once-per-version.
    this.events.emit('update', { status: 'available', version: latest } satisfies UpdateEvent);
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

  private async isIdle(): Promise<boolean> {
    return isRuntimeIdle();
  }

  /**
   * The boot half of the restart sentinel: every attempt still PENDING was
   * interrupted by its own handoff. It succeeded exactly when this process
   * runs the version it targeted.
   */
  private async resolvePendingAttempts(): Promise<void> {
    const pending = await prisma.updateAttempt.findMany({ where: { outcome: 'PENDING' } });
    for (const row of pending) {
      const success = config.appVersion === row.versionTo;
      await this.finishAttempt(row, success ? 'SUCCESS' : 'FAILURE', success ? null : 'restart_version_mismatch', null);
      if (success) {
        logger.info(`[Update] updated ${row.versionFrom} -> ${row.versionTo}`);
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
