/**
 * Monitor manager for `monitor` / `monitor_stop`.
 *
 * A monitor runs a shell command in the agent's execution environment and turns
 * each line the command prints on stdout into an event for the chat conversation
 * that started it (`taskNotificationService`). The lines that arrive within
 * `BATCH_MS` of the first go out as one notification, in order, so a command
 * that never pauses still sends one every `BATCH_MS`. stderr is read and
 * dropped, so a full pipe never blocks the command. The watch ends
 * when the command exits, when its deadline passes, when it prints more often
 * than `MAX_NOTIFICATIONS_PER_MINUTE`, or when the agent stops it. Every end but
 * the agent's own stop sends one last notice, stored under the monitor's id, so
 * it reaches the conversation once. A command that ignores SIGTERM gets SIGKILL
 * after `KILL_GRACE_MS`.
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
import { agentProcesses } from '../../lib/agent-processes';
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
/** How long a stopped command gets to honour SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

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
  /** Events sent so far, which the notice after a restart reports. */
  events?: number;
  /** Events not stored in the conversation yet, sent again before the last notice. */
  unsent?: MonitorEvent[];
}

/** One event, under the id its notification is stored as. */
interface MonitorEvent {
  id: string;
  text: string;
}

interface Monitor {
  id: string;
  params: MonitorParams;
  proc: ExecProcess;
  work: MonitorWork;
  startedAt: number;
  events: number;
  /** Text after the last newline, which becomes a line once its newline arrives. */
  partial: string;
  /** At most `MAX_BATCH_LINES`; the lines past them are only counted. */
  batch: string[];
  droppedLines: number;
  batchTimer?: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
  /** When recent notifications went out, for the rate limit. */
  sent: number[];
  /** Event sends not settled yet. */
  sending: Promise<void>[];
  /** Why the runtime stopped the command, when it did. */
  reason?: MonitorEndReason;
  /** Set by `monitor_stop`: the agent stopped it, so no notice goes out. */
  stoppedByAgent?: boolean;
  /** Set once the process has exited. */
  exited?: boolean;
  /** Set once the watch has ended: later output is dropped. */
  ended?: boolean;
}

class MonitorManager {
  private monitors = new Map<string, Monitor>();
  /** Starts waiting for their pending-work row, which hold a slot already. */
  private starting = 0;
  /** Notifications go out one at a time, so a conversation reads them in the order printed. */
  private queue: Promise<void> = Promise.resolve();

  runningCount(): number {
    return this.starting + this.monitors.size;
  }

  async start(params: MonitorParams): Promise<string> {
    // A step's tool calls run in parallel, so the slot is taken before the await.
    if (this.runningCount() >= MAX_MONITORS) {
      throw new Error(`At most ${MAX_MONITORS} monitors run at once. Stop one with monitor_stop first.`);
    }
    const id = randomUUID();
    const work: MonitorWork = { description: params.description, notify: params.notify };
    this.starting++;
    try {
      // Before the command: a restart in between finds the row and tells the conversation.
      await pendingWorkService.begin('monitor', id, { ...work });
    } finally {
      this.starting--;
    }

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
      work,
      startedAt: Date.now(),
      events: 0,
      partial: '',
      batch: [],
      droppedLines: 0,
      deadline: setTimeout(() => this.halt(monitor, 'timeout'), timeoutMs).unref(),
      sent: [],
      sending: [],
    };
    this.monitors.set(id, monitor);
    this.recordProcess(monitor);

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.read(monitor, chunk));
    // Only stdout is an event. Unread, stderr would fill its pipe and block the command.
    proc.stderr?.resume();
    // The last lines can still be in the pipe when the process exits. A grandchild
    // that inherited the pipe can hold it open, so the wait for it is short.
    void proc.ended
      .then(() => {
        monitor.exited = true;
        return Promise.race([proc.closed, new Promise((resolve) => setTimeout(resolve, PIPE_DRAIN_MS).unref())]);
      })
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
    this.terminate(monitor);
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
      const events = work.events ?? 0;
      const unsent = (work.unsent ?? []).map((event) => this.sendEvent(item.key, work, event));
      trackEvent('monitor ended', work.notify.userId, {
        'agent.id': work.notify.agentId,
        'monitor.id': item.key,
        'monitor.reason': 'restart',
        'monitor.events': String(events),
      });
      const text = renderMonitorEnd({ monitorId: item.key, description: work.description, reason: 'restart', events });
      await Promise.all([...unsent, this.deliver(work.notify, text, item.key)]).then(
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

  /** A command a secure takeover holds starts on `resume`, and only then has a process to record. */
  private recordProcess(monitor: Monitor): void {
    const save = (): boolean => {
      if (!monitor.proc.mark) return false;
      monitor.work.process = monitor.proc.mark;
      pendingWorkService.update('monitor', monitor.id, { ...monitor.work });
      return true;
    };
    if (save()) return;
    const onResume = () => {
      if (save()) agentProcesses.off('resume', onResume);
    };
    agentProcesses.on('resume', onResume);
    void monitor.proc.ended.then(() => agentProcesses.off('resume', onResume));
  }

  /** Store one event; once it is stored, its row no longer lists it. */
  private sendEvent(monitorId: string, work: MonitorWork, event: MonitorEvent): Promise<void> {
    return this.deliver(work.notify, event.text, event.id).then(() => {
      work.unsent = work.unsent?.filter((pending) => pending.id !== event.id);
      pendingWorkService.update('monitor', monitorId, { ...work });
    });
  }

  private read(monitor: Monitor, chunk: string): void {
    if (monitor.ended) return;
    const lines = (monitor.partial + chunk).split('\n');
    // A line with no newline yet keeps only what an event shows of it, plus one
    // character so the cut is marked.
    monitor.partial = (lines.pop() ?? '').slice(0, MAX_LINE_CHARS + 1);
    const full = lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    if (full.length === 0) return;
    const room = Math.max(0, MAX_BATCH_LINES - monitor.batch.length);
    monitor.batch.push(...full.slice(0, room));
    monitor.droppedLines += Math.max(0, full.length - room);
    // From the batch's first line, so a command that never pauses still sends events.
    monitor.batchTimer ??= setTimeout(() => this.flush(monitor), BATCH_MS).unref();
  }

  private flush(monitor: Monitor): void {
    clearTimeout(monitor.batchTimer);
    monitor.batchTimer = undefined;
    const dropped = monitor.droppedLines;
    monitor.droppedLines = 0;
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
    const shown = monitor.batch.splice(0).map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
    );
    if (dropped > 0) shown.push(`[${dropped} more lines]`);
    const text = renderMonitorEvent({ monitorId: monitor.id, description: monitor.params.description, lines: shown });
    const event = { id: `${monitor.id}:${monitor.events}`, text };
    // In the row before it is sent: an event a failed store or a restart lost is sent again.
    monitor.work.events = monitor.events;
    monitor.work.unsent = [...(monitor.work.unsent ?? []), event];
    pendingWorkService.update('monitor', monitor.id, { ...monitor.work });
    monitor.sending.push(
      this.sendEvent(monitor.id, monitor.work, event).catch((err) =>
        logger.error({ err, monitorId: monitor.id }, '[Monitor] Could not send an event'),
      ),
    );
  }

  /** The runtime stops the command; `end` sends the notice once it has exited. */
  private halt(monitor: Monitor, reason: MonitorEndReason): void {
    if (monitor.reason || monitor.stoppedByAgent) return;
    monitor.reason = reason;
    this.terminate(monitor);
  }

  /** SIGTERM, then SIGKILL for a command still running after the grace period. */
  private terminate(monitor: Monitor): void {
    monitor.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!monitor.exited) monitor.proc.kill('SIGKILL');
    }, KILL_GRACE_MS).unref();
  }

  private end(monitor: Monitor): void {
    monitor.ended = true;
    clearTimeout(monitor.deadline);
    this.monitors.delete(monitor.id);
    // A child that still holds stdout prints nothing more into this watch.
    monitor.proc.stdout?.removeAllListeners('data');
    monitor.proc.stdout?.destroy();
    monitor.proc.stderr?.destroy();
    monitor.proc.kill('SIGKILL');
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

    const text =
      reason === 'stopped'
        ? null
        : renderMonitorEnd({ monitorId: monitor.id, description, reason, events: monitor.events, exitCode: monitor.proc.exitCode });
    // Once the sends settle, the events still listed are the ones whose store failed.
    void Promise.all(monitor.sending)
      .then(() => {
        const sends = (monitor.work.unsent ?? []).map((event) => this.sendEvent(monitor.id, monitor.work, event));
        if (text) sends.push(this.deliver(notify, text, monitor.id));
        return Promise.all(sends);
      })
      .then(
      () => pendingWorkService.end('monitor', monitor.id),
      (err) => logger.error({ err, monitorId: monitor.id }, '[Monitor] Could not report the end of a monitor'),
    );
  }

  /** `messageId` makes the delivery idempotent: a stored id is not stored again. */
  private deliver(target: TaskNotificationTarget, text: string, messageId: string = randomUUID()): Promise<void> {
    const next = this.queue.then(async () => {
      // Imported at the call: the service reaches the conversation engine, whose
      // tool collection imports this module.
      const { taskNotificationService } = await import('../../services/task-notification.service');
      await taskNotificationService.deliver(target, messageId, text);
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

