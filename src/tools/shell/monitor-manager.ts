/**
 * Monitor manager for `monitor` / `monitor_stop`.
 *
 * A monitor runs a shell command in the agent's execution environment and turns
 * each line the command prints on stdout into an event for the chat conversation
 * that started it (`taskNotificationService`). Lines that arrive within
 * `BATCH_MS` of each other go out as one notification, in order. The watch ends
 * when the command exits, when its deadline passes, when it prints more often
 * than `MAX_NOTIFICATIONS_PER_MINUTE`, or when the agent stops it. Every end but
 * the agent's own stop sends one last notice.
 *
 * A monitor is pending work from its start until its last notice is stored. A
 * restart stops the command, so the next boot stops a process a crash left
 * running and tells the conversation that the watch ended.
 */
import { randomUUID } from 'crypto';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import { getExecutionEnvironmentFor } from '../../lib/execution-environments/get-execution-environment';
import type { ExecProcess, ProcessMark } from '../../lib/execution-environments/execution-environment';
import { stopLeftoverProcess } from '../../lib/execution-environments/leftover-process';
import { pendingWorkService, type PendingWorkItem } from '../../services/pending-work.service';
import type { TaskNotificationTarget } from '../../services/task-notification.service';
import {
  renderMonitorEnd,
  renderMonitorEvent,
  type MonitorEndReason,
} from '../../prompts/task-notification-prompt';

export const MAX_MONITORS = 5;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
/** Lines printed this close together are one event. */
export const BATCH_MS = 200;
/** Each notification can start a turn, so a command that prints more often than this is stopped. */
export const MAX_NOTIFICATIONS_PER_MINUTE = 12;
const MAX_LINE_CHARS = 2_000;
const PIPE_DRAIN_MS = 1_000;
const MAX_BATCH_LINES = 50;

export interface MonitorParams {
  command: string;
  description: string;
  timeoutMs?: number;
  workdir: string;
  notify: TaskNotificationTarget;
}

/** A monitor, as `pending_work` holds it until its last notice is stored. */
interface MonitorWork {
  description: string;
  notify: TaskNotificationTarget;
  /** The command's process, which the next boot stops when a crash left it running. */
  process?: ProcessMark;
}

interface Monitor {
  id: string;
  params: MonitorParams;
  proc: ExecProcess;
  startedAt: number;
  events: number;
  /** Text after the last newline, which becomes a line once its newline arrives. */
  partial: string;
  batch: string[];
  batchTimer?: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
  /** When recent notifications went out, for the rate limit. */
  sent: number[];
  /** Why the runtime stopped the command, when it did. */
  reason?: MonitorEndReason;
  /** Set by `monitor_stop`: the agent stopped it, so no notice goes out. */
  stoppedByAgent?: boolean;
}

class MonitorManager {
  private monitors = new Map<string, Monitor>();
  /** Notifications go out one at a time, so a conversation reads them in the order printed. */
  private queue: Promise<void> = Promise.resolve();

  runningCount(): number {
    return this.monitors.size;
  }

  async start(params: MonitorParams): Promise<string> {
    if (this.monitors.size >= MAX_MONITORS) {
      throw new Error(`At most ${MAX_MONITORS} monitors run at once. Stop one with monitor_stop first.`);
    }
    const id = randomUUID();
    const work: MonitorWork = { description: params.description, notify: params.notify };
    // Before the command: a restart in between finds the row and tells the conversation.
    await pendingWorkService.begin('monitor', id, work);

    const environment = getExecutionEnvironmentFor(params.workdir);
    const proc = environment.runShell(params.command, {
      cwd: params.workdir,
      env: environment.baseEnv(),
      stdin: 'ignore',
    });
    const timeoutMs = Math.min(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const monitor: Monitor = {
      id,
      params,
      proc,
      startedAt: Date.now(),
      events: 0,
      partial: '',
      batch: [],
      deadline: setTimeout(() => this.halt(monitor, 'timeout'), timeoutMs).unref(),
      sent: [],
    };
    this.monitors.set(id, monitor);
    if (proc.mark) pendingWorkService.update('monitor', id, { ...work, process: proc.mark });

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.read(monitor, chunk));
    // The last lines can still be in the pipe when the process exits. A grandchild
    // that inherited the pipe can hold it open, so the wait for it is short.
    void proc.ended
      .then(() => Promise.race([proc.closed, new Promise((resolve) => setTimeout(resolve, PIPE_DRAIN_MS).unref())]))
      .then(() => this.end(monitor));

    trackEvent('monitor started', params.notify.userId, {
      'agent.id': params.notify.agentId,
      'thread.id': params.notify.threadId,
      'monitor.id': id,
      'monitor.timeout_ms': String(timeoutMs),
    });
    logger.info({ monitorId: id, timeoutMs }, '[Monitor] started');
    return id;
  }

  /** Stop a monitor the agent no longer needs. Answers whether it was running. */
  stop(monitorId: string): boolean {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) return false;
    monitor.stoppedByAgent = true;
    monitor.proc.kill('SIGTERM');
    return true;
  }

  /**
   * Tell each conversation whose monitor a restart stopped that the watch ended,
   * after stopping a command a crash left running.
   */
  async resume(items: PendingWorkItem[], givenUp: PendingWorkItem[] = []): Promise<void> {
    for (const item of [...items, ...givenUp]) {
      const work = item.payload as unknown as MonitorWork;
      if (work.process) await stopLeftoverProcess(work.process);
    }
    for (const item of items) {
      const work = item.payload as unknown as MonitorWork;
      const text = renderMonitorEnd({ monitorId: item.key, description: work.description, reason: 'restart', events: 0 });
      await this.deliver(work.notify, text).then(
        () => pendingWorkService.end('monitor', item.key),
        (err) => logger.error({ err, monitorId: item.key }, '[Monitor] Could not report the monitor a restart stopped'),
      );
    }
  }

  /** Stop every monitor without a notice, as a test's cleanup does. */
  killAll(): void {
    for (const monitor of this.monitors.values()) {
      monitor.stoppedByAgent = true;
      monitor.proc.kill('SIGKILL');
    }
  }

  // ---------- internal ----------

  private read(monitor: Monitor, chunk: string): void {
    const lines = (monitor.partial + chunk).split('\n');
    monitor.partial = lines.pop() ?? '';
    const full = lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    if (full.length === 0) return;
    monitor.batch.push(...full);
    clearTimeout(monitor.batchTimer);
    monitor.batchTimer = setTimeout(() => this.flush(monitor), BATCH_MS).unref();
  }

  private flush(monitor: Monitor): void {
    clearTimeout(monitor.batchTimer);
    if (monitor.batch.length === 0 || monitor.stoppedByAgent || monitor.reason === 'too-many-events') {
      monitor.batch = [];
      return;
    }
    const now = Date.now();
    monitor.sent = monitor.sent.filter((at) => now - at < 60_000);
    if (monitor.sent.length >= MAX_NOTIFICATIONS_PER_MINUTE) {
      monitor.batch = [];
      this.halt(monitor, 'too-many-events');
      return;
    }
    monitor.sent.push(now);
    monitor.events++;
    const lines = monitor.batch.splice(0).map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
    );
    const shown = lines.slice(0, MAX_BATCH_LINES);
    if (lines.length > shown.length) shown.push(`[${lines.length - shown.length} more lines]`);
    const text = renderMonitorEvent({ monitorId: monitor.id, description: monitor.params.description, lines: shown });
    void this.deliver(monitor.params.notify, text).catch((err) =>
      logger.error({ err, monitorId: monitor.id }, '[Monitor] Could not send an event'),
    );
  }

  /** The runtime stops the command; `end` sends the notice once it has exited. */
  private halt(monitor: Monitor, reason: MonitorEndReason): void {
    if (monitor.reason || monitor.stoppedByAgent) return;
    monitor.reason = reason;
    monitor.proc.kill('SIGTERM');
  }

  private end(monitor: Monitor): void {
    clearTimeout(monitor.deadline);
    this.monitors.delete(monitor.id);
    // A shutdown leaves the row, and the next boot reports the end.
    if (pendingWorkService.shutdownSignal.aborted) return;
    if (monitor.partial.trim() !== '') monitor.batch.push(monitor.partial);
    monitor.partial = '';
    this.flush(monitor);

    const reason = monitor.stoppedByAgent ? 'stopped' : (monitor.reason ?? 'exit');
    const { notify, description } = monitor.params;
    trackEvent('monitor ended', notify.userId, {
      'agent.id': notify.agentId,
      'monitor.id': monitor.id,
      'monitor.reason': reason,
      'monitor.events': String(monitor.events),
      'monitor.elapsed_ms': String(Date.now() - monitor.startedAt),
    });
    logger.info({ monitorId: monitor.id, reason, events: monitor.events }, '[Monitor] ended');

    if (reason === 'stopped') {
      pendingWorkService.end('monitor', monitor.id);
      return;
    }
    const text = renderMonitorEnd({
      monitorId: monitor.id,
      description,
      reason,
      events: monitor.events,
      exitCode: monitor.proc.exitCode,
    });
    void this.deliver(notify, text).then(
      () => pendingWorkService.end('monitor', monitor.id),
      (err) => logger.error({ err, monitorId: monitor.id }, '[Monitor] Could not report the end of a monitor'),
    );
  }

  private deliver(target: TaskNotificationTarget, text: string): Promise<void> {
    const next = this.queue.then(async () => {
      // Imported at the call: the service reaches the conversation engine, whose
      // tool collection imports this module.
      const { taskNotificationService } = await import('../../services/task-notification.service');
      await taskNotificationService.deliver(target, randomUUID(), text);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

let singleton: MonitorManager | null = null;
export function getMonitorManager(): MonitorManager {
  if (!singleton) singleton = new MonitorManager();
  return singleton;
}

/** Test-only: stop every monitor and start again with an empty manager. */
export function __resetMonitorManagerForTests(): void {
  singleton?.killAll();
  singleton = null;
}

