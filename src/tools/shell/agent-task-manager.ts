/**
 * Agent task manager for `coding_agent` / `coding_agent_status` / `coding_agent_stop`.
 *
 * TypeScript port of the upstream Lens Agents shell sandbox's agent task
 * manager. Hands each task to the configured `CodingAgent`, buffers the run's
 * text for drain-on-read polling, and tracks completion state. How the agent is
 * launched and read is the adapter's business (`lib/coding-agents/`); this
 * module sees only the neutral events a run emits.
 *
 * One in-process manager per agent-runtime, at most MAX_CONCURRENT tasks
 * running at once. The agent invokes `startTask()` via the `coding_agent` tool,
 * polls via `readStatus()` from `coding_agent_status`, and abandons a task via
 * `stopTask()` from `coding_agent_stop`.
 */
import { randomUUID } from 'crypto';
import { config, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { getCodingAgent } from '../../lib/coding-agents/get-coding-agent';
import type {
  CodingAgent,
  CodingAgentRun,
  CodingAgentStopReason,
  CodingAgentTask,
} from '../../lib/coding-agents/coding-agent';
import { sandboxEnv } from './sandbox-env';

export const MAX_CONCURRENT = 3;
export const DEFAULT_WAIT_MS = 5_000;
export const DEFAULT_MAX_TURNS = 100;
export const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MiB
/**
 * How long stopTask waits for a stopped run's stream to end before reporting
 * the stop itself. Covers the adapter's graceful-then-forced termination.
 */
export const STOP_WAIT_MS = 2_500;

export interface AgentTaskParams {
  agent?: CodingAgentName;
  prompt: string;
  workdir?: string;
  appendSystemPrompt?: string;
  mode?: 'edit' | 'plan';
  modelTier?: CodingAgentTask['modelTier'];
  effort?: CodingAgentTask['effort'];
  maxTurns?: number;
  sessionId?: string;
  debug?: boolean;
}

export interface AgentTaskStatus {
  agent: CodingAgentName;
  output: string;
  completed: boolean;
  result?: string;
  turns?: number;
  stopReason?: string;
  sessionId?: string;
}

type TaskStopReason = CodingAgentStopReason | 'stopped';

interface TaskState {
  agent: CodingAgentName;
  outputBuffer: string;
  completed: boolean;
  result?: string;
  turns?: number;
  stopReason?: TaskStopReason;
  sessionId?: string;
}

interface TaskEntry {
  agent: CodingAgent;
  state: TaskState;
  waiters: Array<() => void>;
  reading: boolean;
  run: CodingAgentRun;
  /** Set by stopTask so drive()'s finalize reports 'stopped', not 'error'. */
  stopping?: boolean;
  /** The drive() promise, so stopTask can await the final drain. */
  driver?: Promise<void>;
}

export class AgentTaskManager {
  private tasks = new Map<string, TaskEntry>();
  private reaped = new Set<string>();

  constructor(
    private readonly resolveAgent: (name: CodingAgentName) => CodingAgent = getCodingAgent,
  ) {}

  /** Number of tasks that haven't completed yet. */
  runningCount(): number {
    let n = 0;
    for (const entry of this.tasks.values()) if (!entry.state.completed) n++;
    return n;
  }

  startTask(params: AgentTaskParams): { taskId: string; agent: CodingAgentName } {
    if (this.runningCount() >= MAX_CONCURRENT) {
      throw new Error(`Max concurrent agent tasks (${MAX_CONCURRENT}) reached`);
    }

    const agent = this.resolveAgent(params.agent ?? config.codingAgent);
    const taskId = randomUUID();
    const task: CodingAgentTask = {
      taskId,
      prompt: params.prompt,
      workdir: params.workdir,
      env: sandboxEnv(),
      mode: params.mode ?? 'edit',
      modelTier: params.modelTier,
      effort: params.effort,
      maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
      appendSystemPrompt: params.appendSystemPrompt,
      sessionId: params.sessionId,
      debug: params.debug,
      gateMode: config.toolRiskGateMode,
    };

    const state: TaskState = { agent: agent.id, outputBuffer: '', completed: false };
    const run = agent.run(task);
    const entry: TaskEntry = { agent, state, waiters: [], reading: false, run };
    this.tasks.set(taskId, entry);

    logger.info(
      {
        taskId,
        agent: agent.id,
        promptLen: task.prompt.length,
        maxTurns: task.maxTurns,
        mode: task.mode,
      },
      '[AgentTask] starting task',
    );

    // Kept on the entry so stopTask can await the finalize instead of racing
    // it. Rejections are logged here because nothing else awaits the driver on
    // the normal path.
    entry.driver = this.drive(taskId, entry).catch((err) => {
      logger.error({ err, taskId }, '[AgentTask] driver failed');
      entry.state.completed = true;
      entry.state.stopReason = 'error';
      entry.state.result = 'Coding task failed while reading output.';
      this.notify(entry);
    });
    return { taskId, agent: agent.id };
  }

  async readStatus(taskId: string, waitMs?: number): Promise<AgentTaskStatus> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      if (this.reaped.has(taskId)) {
        throw new Error(`Task ${taskId} has already ended and been cleaned up`);
      }
      throw new Error(`Unknown task: ${taskId}`);
    }
    if (entry.reading) {
      throw new Error(`Task ${taskId} already has a pending read`);
    }

    // Immediate drain if anything to deliver.
    if (entry.state.outputBuffer !== '' || entry.state.completed) {
      return this.drainAndMaybeReap(taskId, entry);
    }

    // Wait for output or completion, bounded by waitMs.
    entry.reading = true;
    try {
      const waited = new Promise<void>((resolve) => entry.waiters.push(resolve));
      const timer = new Promise<void>((resolve) =>
        setTimeout(resolve, waitMs ?? DEFAULT_WAIT_MS).unref(),
      );
      await Promise.race([waited, timer]);
    } finally {
      entry.reading = false;
    }

    // The entry might have been reaped while we waited — by a concurrent
    // stopTask, or by killAll. The state object we still hold carries the real
    // outcome, so report that rather than inventing a failure; its output has
    // already been delivered to whoever reaped it.
    const stillThere = this.tasks.get(taskId);
    if (!stillThere) {
      return drainTask(entry.state);
    }
    return this.drainAndMaybeReap(taskId, stillThere);
  }

  /**
   * Terminate a running task and hand back whatever it produced before it died.
   *
   * The entry is reaped unconditionally — the final output goes out in this
   * response, so nothing is left to poll for and the concurrency slot is freed
   * immediately. That is the point of the call: a task that went the wrong way
   * otherwise holds one of MAX_CONCURRENT slots until it burns its whole turn
   * budget.
   *
   * Unlike readStatus this deliberately ignores `reading`: the escape hatch has
   * to work even while another step is parked in a poll. Whichever of the two
   * drains first gets the output, and the reap is idempotent.
   */
  async stopTask(taskId: string): Promise<AgentTaskStatus> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      if (this.reaped.has(taskId)) {
        throw new Error(`Task ${taskId} has already ended and been cleaned up`);
      }
      throw new Error(`Unknown task: ${taskId}`);
    }

    if (!entry.state.completed) {
      // A run that has already exited is mid-finalize, not running: its result
      // may be read but not yet written to the state. Stopping it and flagging
      // the stop would relabel a task that finished on its own as stopped and
      // throw away its real result.
      if (!entry.run.exited) {
        entry.stopping = true;
        entry.run.stop();
      }
      // Let drive() reach its finalize: the run's stream ends when the agent
      // dies, and the state picks up its result/turns/sessionId. Bounded so an
      // agent that ignores the stop can't hang the tool call.
      await Promise.race([
        entry.driver ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
      ]);
      if (!entry.state.completed) {
        // Outlived the forced stop, or a grandchild is still holding the agent's
        // output open so the stream can never end. Report the stop anyway rather
        // than handing back a half-finished state; the buffered output still goes
        // out in the drain below.
        entry.state.completed = true;
        entry.state.stopReason = 'stopped';
        entry.state.result ??=
          'Task stopped; it did not exit cleanly, so no final result was captured.';
        // Wake anything parked in readStatus. Only drive()'s finalize notifies,
        // and drive() finalizing is precisely what did not happen here — without
        // this, a concurrent poll sleeps out its whole waitMs (up to 30s).
        this.notify(entry);
      }
    }

    const status = drainTask(entry.state);
    this.reap(taskId);
    logger.info({ taskId, stopReason: status.stopReason }, '[AgentTask] stopped');
    return status;
  }

  killAll(): void {
    for (const [taskId, entry] of this.tasks) {
      if (!entry.state.completed) {
        try {
          entry.run.stop();
        } catch (err) {
          logger.warn({ err, taskId }, '[AgentTask] kill failed');
        }
        entry.state.completed = true;
        entry.state.stopReason = 'error';
      }
      for (const w of entry.waiters) w();
      entry.waiters = [];
    }
    this.tasks.clear();
    this.reaped.clear();
  }

  // ---------- internal ----------

  private drainAndMaybeReap(taskId: string, entry: TaskEntry): AgentTaskStatus {
    const status = drainTask(entry.state);
    const hadOutput = status.output !== '';
    if (entry.state.completed && !hadOutput) this.reap(taskId);
    return status;
  }

  /** Forget a task, remembering the id so a later poll can say why it's gone. */
  private reap(taskId: string): void {
    this.tasks.delete(taskId);
    this.reaped.add(taskId);
    // Keep the reaped set from growing without bound.
    if (this.reaped.size > MAX_CONCURRENT * 10) {
      const first = this.reaped.values().next().value;
      if (first !== undefined) this.reaped.delete(first);
    }
  }

  private notify(entry: TaskEntry): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w();
  }

  private async drive(taskId: string, entry: TaskEntry): Promise<void> {
    const state = entry.state;
    const texts: string[] = [];
    let outcome: { stopReason: CodingAgentStopReason; turns: number; message: string } | null =
      null;

    for await (const event of entry.run.events) {
      if (event.type === 'text') {
        texts.push(event.text);
        appendBuffer(state, event.text);
        this.notify(entry);
      } else if (event.type === 'session') {
        // Recorded as it arrives so a *stopped* task can be resumed — including
        // when stopTask has to give up on this loop ever ending and finalize the
        // state itself. drainTask only exposes it once the task is complete, so
        // an in-flight poll is unaffected.
        state.sessionId = event.sessionId;
      } else {
        outcome = event;
      }
    }

    const fullText = texts.length > 0 ? texts.join('\n\n') : undefined;
    // The contract says every stream ends with a result; an adapter that breaks
    // it gets a failed task rather than a task that never completes.
    outcome ??= {
      stopReason: 'error',
      turns: 0,
      message: `${entry.agent.displayName} ended without reporting a result`,
    };

    let stopReason: TaskStopReason = outcome.stopReason;
    let result: string;
    if (entry.stopping) {
      // We are why it died, so don't read its exit as a failure. Keep whatever
      // text it managed to produce.
      stopReason = 'stopped';
      result = fullText ?? 'Task stopped before producing any output.';
    } else if (outcome.stopReason === 'end_turn') {
      result = fullText ?? outcome.message;
    } else {
      result = fullText
        ? `${fullText}\n\n[${outcome.stopReason}]: ${outcome.message}`
        : `Error (${outcome.stopReason}): ${outcome.message}`;
    }

    state.completed = true;
    state.result = result;
    state.turns = outcome.turns;
    state.stopReason = stopReason;

    this.notify(entry);
    logger.info({ taskId, stopReason, turns: outcome.turns }, '[AgentTask] completed');
  }
}

function appendBuffer(state: TaskState, text: string): void {
  state.outputBuffer += text;
  if (state.outputBuffer.length > MAX_BUFFER_SIZE) {
    const start = state.outputBuffer.length - MAX_BUFFER_SIZE;
    state.outputBuffer = `[...output truncated...]\n${state.outputBuffer.slice(start)}`;
  }
}

function drainTask(state: TaskState): AgentTaskStatus {
  const output = state.outputBuffer;
  state.outputBuffer = '';
  return {
    agent: state.agent,
    output,
    completed: state.completed,
    result: state.completed ? state.result : undefined,
    turns: state.completed ? state.turns : undefined,
    stopReason: state.completed ? state.stopReason : undefined,
    sessionId: state.completed ? state.sessionId : undefined,
  };
}

// Singleton for the tools to share across tool calls.
let singleton: AgentTaskManager | null = null;
export function getAgentTaskManager(): AgentTaskManager {
  if (!singleton) singleton = new AgentTaskManager();
  return singleton;
}

/** Test-only: replace the singleton with a manager built on a stub agent. */
export function __setAgentTaskManagerForTests(manager: AgentTaskManager | null): void {
  singleton = manager;
}
