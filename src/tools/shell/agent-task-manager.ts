/**
 * Agent task manager for `coding_agent` / `coding_agent_status` / `coding_agent_stop`.
 *
 * TypeScript port of the upstream Mirantis Agent Platform shell sandbox's agent task
 * manager. Hands each task to the configured `CodingAgent`, buffers the run's
 * text for drain-on-read polling, and tracks completion state. How the agent is
 * launched and read is the adapter's business (`lib/coding-agents/`); this
 * module sees only the neutral events a run emits.
 *
 * One in-process manager per agent-runtime, at most MAX_CONCURRENT tasks
 * running at once. The agent invokes `startTask()` via the `coding_agent` tool,
 * polls via `readStatus()` from `coding_agent_status`, and abandons a task via
 * `stopTask()` from `coding_agent_stop`.
 *
 * A task is pending work from its start until the agent has read how it ended.
 * The boot relaunches a task a restart stopped, resuming its session when one
 * was reported, and keeps the result of a task that ended unread. A relaunch
 * first stops the process a crash left running, so two runs never share a session.
 */
import { randomUUID } from 'crypto';
import { config, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import { agentMcpServers } from '../../lib/agent-mcp-servers';
import { getCodingAgent } from '../../lib/coding-agents/get-coding-agent';
import type {
  CodingAgent,
  CodingAgentRefusal,
  CodingAgentRun,
  CodingAgentStopReason,
  CodingAgentTask,
} from '../../lib/coding-agents/coding-agent';
import { getExecutionEnvironmentFor } from '../../lib/execution-environments/get-execution-environment';
import type { ProcessMark } from '../../lib/execution-environments/execution-environment';
import { stopLeftoverProcess } from '../../lib/execution-environments/leftover-process';
import { pluginMcpService } from '../../services/plugin-mcp.service';
import { pendingWorkService, type PendingWorkItem } from '../../services/pending-work.service';
import { RESUMED_CODING_TASK_PROMPT } from '../../prompts/resume-prompt';

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
  refusals?: CodingAgentRefusal[];
}

/** `refused`: the agent finished, but its permission checks refused part of the work. */
type TaskStopReason = CodingAgentStopReason | 'stopped' | 'refused';

/** A task, as `pending_work` holds it until the agent has read how it ended. */
interface CodingTaskWork {
  /** What the task was started with. */
  params: AgentTaskParams & { agent: CodingAgentName };
  /** The session the agent reported, which a relaunch resumes. */
  sessionId?: string;
  /** The running agent's process, which a relaunch stops first when a crash left it running. */
  process?: ProcessMark;
  /** How the run ended, kept until `coding_agent_status` reports it. */
  finished?: Pick<TaskState, 'result' | 'turns' | 'stopReason' | 'refusals'>;
}

interface TaskState {
  agent: CodingAgentName;
  outputBuffer: string;
  completed: boolean;
  result?: string;
  turns?: number;
  stopReason?: TaskStopReason;
  sessionId?: string;
  refusals?: CodingAgentRefusal[];
}

interface TaskEntry {
  mode: CodingAgentTask['mode'];
  state: TaskState;
  waiters: Array<() => void>;
  reading: boolean;
  /** Absent for a task whose run ended before a restart, kept only to report its result. */
  run?: CodingAgentRun;
  params: CodingTaskWork['params'];
  /** Set by stopTask so drive()'s finalize reports 'stopped', not 'error'. */
  stopping?: boolean;
  /** The drive() promise, so stopTask can await the final drain. */
  driver?: Promise<void>;
}

export class AgentTaskManager {
  private tasks = new Map<string, TaskEntry>();
  private reaped = new Set<string>();
  /** Starts waiting for their pending-work row, which hold a slot already. */
  private starting = 0;

  constructor(
    private readonly resolveAgent: (name: CodingAgentName) => CodingAgent = getCodingAgent,
  ) {}

  /** Number of tasks that haven't completed yet. */
  runningCount(): number {
    let n = this.starting;
    for (const entry of this.tasks.values()) if (!entry.state.completed) n++;
    return n;
  }

  /** Rejects without launching when the task cannot be recorded, since a restart would lose it. */
  async startTask(params: AgentTaskParams): Promise<{ taskId: string; agent: CodingAgentName }> {
    if (this.runningCount() >= MAX_CONCURRENT) {
      throw new Error(`Max concurrent agent tasks (${MAX_CONCURRENT}) reached`);
    }

    // Before the row: an agent that is not available refuses the task, and no boot retries it.
    const name = params.agent ?? config.codingAgent;
    const agent = this.resolveAgent(name);
    const taskId = randomUUID();
    const work: CodingTaskWork = { params: { ...params, agent: name } };
    this.starting++;
    try {
      await pendingWorkService.begin('coding-task', taskId, work);
    } finally {
      this.starting--;
    }
    this.launch(taskId, agent, work.params, work.params);
    return { taskId, agent: agent.id };
  }

  /**
   * Continue the tasks a restart stopped, under their own ids, so the agent's
   * next poll finds them. A task with a session resumes it; one stopped before
   * it reported a session starts again. A task that ended unread reports its result.
   */
  async resume(items: PendingWorkItem[], givenUp: PendingWorkItem[] = []): Promise<void> {
    // The bound gave these up, so nothing relaunches them, and no poll can reach a run left behind.
    for (const item of givenUp) {
      const { process } = item.payload as unknown as CodingTaskWork;
      if (process && (await stopLeftoverProcess(process))) {
        logger.warn({ taskId: item.key }, '[AgentTask] Stopped the run of a task the restarts gave up');
      }
    }
    // A relaunch gives the task the plugins' MCP servers, which no turn has read yet at boot.
    if (items.some((item) => !(item.payload as unknown as CodingTaskWork).finished)) {
      await pluginMcpService.readConfigs();
    }
    for (const item of items) {
      try {
        await this.resumeOne(item.key, item.payload as unknown as CodingTaskWork);
      } catch (err) {
        // An agent whose credentials a restart removed cannot continue its task.
        logger.error({ err, taskId: item.key }, '[AgentTask] Could not continue a task a restart stopped');
        pendingWorkService.end('coding-task', item.key);
      }
    }
  }

  private async resumeOne(taskId: string, work: CodingTaskWork): Promise<void> {
    // A result nobody reads is a boot like any other, so the bound drops it. Reading
    // one needs no agent, so it outlives the agent's credentials.
    if (work.finished) {
      this.tasks.set(taskId, {
        mode: work.params.mode ?? 'edit',
        params: work.params,
        state: {
          agent: work.params.agent,
          outputBuffer: '',
          completed: true,
          ...work.finished,
          sessionId: work.sessionId,
        },
        waiters: [],
        reading: false,
      });
      return;
    }
    const agent = this.resolveAgent(work.params.agent);
    if (work.process && (await stopLeftoverProcess(work.process))) {
      logger.warn({ taskId }, '[AgentTask] Stopped the run a crash left running');
    }
    const relaunch = work.sessionId
      ? { ...work.params, sessionId: work.sessionId, prompt: RESUMED_CODING_TASK_PROMPT }
      : work.params;
    this.launch(taskId, agent, work.params, relaunch);
  }

  /**
   * Run `params` as task `taskId` on `agent`. `original` is what the task was
   * started with, which the pending-work row keeps across relaunches.
   */
  private launch(
    taskId: string,
    agent: CodingAgent,
    original: CodingTaskWork['params'],
    params: AgentTaskParams,
  ): void {
    const task: CodingAgentTask = {
      taskId,
      prompt: params.prompt,
      workdir: params.workdir,
      // The environment that will run it, which the workdir decides: a thread
      // rooted outside the container's mounts runs on the host, and the host's
      // `PATH` and `HOME` are exactly what the container's environment drops.
      env: getExecutionEnvironmentFor(params.workdir).baseEnv(),
      mode: params.mode ?? 'edit',
      modelTier: params.modelTier,
      effort: params.effort,
      maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
      appendSystemPrompt: params.appendSystemPrompt,
      sessionId: params.sessionId,
      debug: params.debug,
      mcpServers: agentMcpServers(params.workdir),
    };

    // A session it resumes is its session until the agent reports one, so a
    // restart before that report relaunches the same session again.
    const state: TaskState = {
      agent: agent.id,
      outputBuffer: '',
      completed: false,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
    const run = agent.run(task);
    const entry: TaskEntry = { mode: task.mode, state, waiters: [], reading: false, run, params: original };
    this.tasks.set(taskId, entry);
    this.record(taskId, entry);
    // A run can start its process after this, and the next boot stops a
    // process left running only by the mark recorded here.
    void run.started.then(() => this.record(taskId, entry));

    logger.info(
      {
        taskId,
        agent: agent.id,
        promptLen: task.prompt.length,
        maxTurns: task.maxTurns,
        mode: task.mode,
        mcpServers: task.mcpServers.length,
      },
      '[AgentTask] starting task',
    );

    // Kept on the entry so stopTask can await the finalize instead of racing
    // it. Rejections are logged here because nothing else awaits the driver on
    // the normal path.
    entry.driver = this.drive(taskId, entry, agent, run).catch((err) => {
      logger.error({ err, taskId }, '[AgentTask] driver failed');
      entry.state.completed = true;
      entry.state.stopReason = 'error';
      entry.state.result = 'Coding task failed while reading output.';
      this.record(taskId, entry);
      this.notify(entry);
    });
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
      if (entry.run && !entry.run.exited) {
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
          entry.run?.stop();
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
    if (!entry.state.completed) return status;
    // A read that hands out output keeps the entry for the poll after it. The
    // agent has read how the task ended either way, so no restart keeps it.
    if (status.output === '') this.reap(taskId);
    else pendingWorkService.end('coding-task', taskId);
    return status;
  }

  /** Forget a task, remembering the id so a later poll can say why it's gone. */
  private reap(taskId: string): void {
    this.tasks.delete(taskId);
    // The agent has read how the task ended, so no restart needs to keep it.
    pendingWorkService.end('coding-task', taskId);
    this.reaped.add(taskId);
    // Keep the reaped set from growing without bound.
    if (this.reaped.size > MAX_CONCURRENT * 10) {
      const first = this.reaped.values().next().value;
      if (first !== undefined) this.reaped.delete(first);
    }
  }

  /** Keep what a relaunch, or the report of an ended run, needs after a restart. */
  private record(taskId: string, entry: TaskEntry): void {
    const { state } = entry;
    const work: CodingTaskWork = {
      params: entry.params,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };
    if (state.completed) {
      const { result, turns, stopReason, refusals } = state;
      const finished = { result, turns, stopReason, ...(refusals ? { refusals } : {}) };
      pendingWorkService.settle('coding-task', taskId, { ...work, finished });
      return;
    }
    const mark = entry.run?.mark;
    pendingWorkService.update('coding-task', taskId, mark ? { ...work, process: mark } : work);
  }

  private notify(entry: TaskEntry): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w();
  }

  private async drive(taskId: string, entry: TaskEntry, agent: CodingAgent, run: CodingAgentRun): Promise<void> {
    const state = entry.state;
    const texts: string[] = [];
    let outcome: {
      stopReason: CodingAgentStopReason;
      turns: number;
      message: string;
      refusals?: CodingAgentRefusal[];
    } | null = null;

    for await (const event of run.events) {
      if (event.type === 'text') {
        texts.push(event.text);
        appendBuffer(state, event.text);
        this.notify(entry);
      } else if (event.type === 'session') {
        // Recorded as it arrives so a *stopped* task can be resumed — including
        // when stopTask has to give up on this loop ever ending and finalize the
        // state itself, and when a restart stops it. drainTask only exposes it
        // once the task is complete, so an in-flight poll is unaffected.
        state.sessionId = event.sessionId;
        this.record(taskId, entry);
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
      message: `${agent.displayName} ended without reporting a result`,
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

    const refusals = outcome.refusals ?? [];
    if (refusals.length > 0) {
      // A refused action is work the task did not do, so a run that otherwise
      // ended cleanly is not reported as a success.
      if (stopReason === 'end_turn') stopReason = 'refused';
      result += `\n\n${describeRefusals(agent.displayName, refusals)}`;
      state.refusals = refusals;
      trackEvent('coding task refused', config.ownerUserId, {
        'task.id': taskId,
        'task.agent': agent.id,
        'task.mode': entry.mode,
        'task.stop_reason': outcome.stopReason,
        'task.refusals': String(refusals.length),
      });
    }

    state.completed = true;
    state.result = result;
    state.turns = outcome.turns;
    state.stopReason = stopReason;

    this.record(taskId, entry);
    this.notify(entry);
    logger.info({ taskId, stopReason, turns: outcome.turns }, '[AgentTask] completed');
  }
}

function describeRefusals(displayName: string, refusals: CodingAgentRefusal[]): string {
  const lines = refusals.map(({ action, target }) => `- ${action}: ${target}`);
  return `[refused]: ${displayName} did not run these actions, because its permission checks refused them:\n${lines.join('\n')}`;
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
    refusals: state.completed ? state.refusals : undefined,
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
