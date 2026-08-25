/**
 * Agent task manager for `claude_code` / `claude_code_status`.
 *
 * TypeScript port of the upstream Lens Agents shell sandbox's agent task
 * manager.
 * Spawns the Claude Code CLI with `--output-format stream-json`,
 * parses the NDJSON stream, buffers assistant text for drain-on-read
 * polling, and tracks completion state.
 *
 * One in-process manager per agent-runtime, at most MAX_CONCURRENT
 * tasks running at once. The agent invokes `startTask()` via the
 * `claude_code` MCP tool, polls via `readStatus()` from
 * `claude_code_status`, and abandons a task via `stopTask()` from
 * `claude_code_stop`.
 */
import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { config } from '../../config';
import { logger } from '../../logger';
import { sandboxEnv } from './sandbox-env';

export const MAX_CONCURRENT = 3;
export const DEFAULT_WAIT_MS = 5_000;
export const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MiB
/** How long a stopped child gets to honour SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 2_000;

/**
 * Plan mode's read-only promise needs an instruction, not just a permission mode.
 * In the off/observe gate branch the sub-agent runs with bypass permissions, and
 * Claude Code auto-approves writes under `--permission-mode plan` whenever bypass
 * is available — verified: a plan-mode run with both flags overwrote a file on
 * request. Appended rather than substituted, so the default harness survives.
 */
export const PLAN_ONLY_INSTRUCTION =
  'You are in plan mode: analyze and plan only. Do not create, modify or delete any files, and do not run commands that change state (installs, commits, pushes, deployments).';

export interface AgentTaskParams {
  prompt: string;
  workdir?: string;
  appendSystemPrompt?: string;
  mode?: 'edit' | 'plan';
  maxTurns?: number;
  sessionId?: string;
  debug?: boolean;
  env?: Record<string, string>;
  /** Path or bare name of the Claude Code CLI binary. Defaults to `claude`. */
  agentCommand?: string;
}

export interface AgentTaskStatus {
  output: string;
  completed: boolean;
  result?: string;
  turns?: number;
  stopReason?: string;
  sessionId?: string;
}

interface TaskState {
  outputBuffer: string;
  completed: boolean;
  result?: string;
  turns?: number;
  stopReason?: string;
  sessionId?: string;
}

interface TaskEntry {
  state: TaskState;
  waiters: Array<() => void>;
  reading: boolean;
  child?: ChildProcess;
  /** Set by stopTask so drive()'s finalize reports 'stopped', not 'error'. */
  stopping?: boolean;
  /** The drive() promise, so stopTask can await the final drain. */
  driver?: Promise<void>;
  /** A spawn failure (ENOENT, unusable cwd), captured before drive() can listen. */
  spawnError?: Error;
}

interface StreamLine {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  subtype?: string;
  result?: string;
  num_turns?: number;
  session_id?: string;
}

interface CliResult {
  result: string;
  turns: number;
  stopReason: string;
  sessionId?: string;
}

/**
 * `spawn`-shaped hook so tests can stub the child process without
 * launching the real `claude` binary.
 */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export class AgentTaskManager {
  private tasks = new Map<string, TaskEntry>();
  private reaped = new Set<string>();
  private readonly spawner: Spawner;

  constructor(spawner: Spawner = spawn as Spawner) {
    this.spawner = spawner;
  }

  /** Number of tasks that haven't completed yet. */
  runningCount(): number {
    let n = 0;
    for (const entry of this.tasks.values()) if (!entry.state.completed) n++;
    return n;
  }

  startTask(params: AgentTaskParams): string {
    if (this.runningCount() >= MAX_CONCURRENT) {
      throw new Error(`Max concurrent agent tasks (${MAX_CONCURRENT}) reached`);
    }

    const taskId = randomUUID();
    const state: TaskState = {
      outputBuffer: '',
      completed: false,
    };
    const entry: TaskEntry = { state, waiters: [], reading: false };
    this.tasks.set(taskId, entry);

    const { command, args } = buildCliCommand(params);
    const child = this.spawner(command, args, {
      cwd: params.workdir,
      env: { ...sandboxEnv(), ...(params.env ?? {}) } as NodeJS.ProcessEnv,
    });
    entry.child = child;

    // A spawn failure — a missing `claude` binary, a workdir that doesn't exist —
    // emits 'error' immediately, well before drive() gets as far as attaching its
    // own listener. Unhandled, that event takes the whole runtime down, so claim
    // it here and let the finalize report it as a failed task.
    child.once('error', (err: Error) => {
      entry.spawnError = err;
      logger.error({ err, taskId }, '[AgentTask] child process error');
    });

    logger.info(
      {
        taskId,
        agentCommand: command,
        promptLen: params.prompt.length,
        maxTurns: params.maxTurns ?? 100,
        mode: params.mode,
      },
      '[AgentTask] starting Claude Code task',
    );

    // Kept on the entry so stopTask can await the finalize instead of racing
    // it. Rejections are logged here because nothing else awaits the driver on
    // the normal path.
    entry.driver = this.drive(taskId, entry, child).catch((err) => {
      logger.error({ err, taskId }, '[AgentTask] driver failed');
    });
    return taskId;
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
      // A child that has already exited is mid-finalize, not running: its result
      // line may be parsed but not yet written to the state. Signalling it and
      // flagging the stop would relabel a task that finished on its own as
      // stopped and throw away its real result.
      const child = entry.child;
      const alreadyExited =
        child !== undefined && (child.exitCode !== null || child.signalCode !== null);
      if (!alreadyExited) {
        entry.stopping = true;
        terminateChild(child, taskId);
      }
      // Let drive() reach its finalize: the child's stdout closes when it dies,
      // the read loop ends, and the state picks up its result/turns/sessionId.
      // Bounded so a child that ignores both signals can't hang the tool call.
      await Promise.race([
        entry.driver ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS + 500).unref()),
      ]);
      if (!entry.state.completed) {
        // Outlived SIGKILL, or a grandchild is still holding its stdout open so
        // drive()'s read loop can never end. Report the stop anyway rather than
        // handing back a half-finished state; the buffered output still goes out
        // in the drain below.
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
          entry.child?.kill('SIGTERM');
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

  private async drive(taskId: string, entry: TaskEntry, child: ChildProcess): Promise<void> {
    const state = entry.state;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;

    if (child.stderr) {
      const stderrReader = createInterface({ input: child.stderr });
      stderrReader.on('line', (line) => {
        logger.debug({ taskId, line }, '[AgentTask] stderr');
        if (stderrBytes < 4096) {
          stderrChunks.push(line);
          stderrBytes += line.length + 1;
        }
      });
    }

    let resultLine: StreamLine | null = null;
    const assistantTexts: string[] = [];

    if (child.stdout) {
      const stdoutReader = createInterface({ input: child.stdout });
      for await (const line of stdoutReader) {
        if (line.length === 0) continue;
        let parsed: StreamLine;
        try {
          parsed = JSON.parse(line) as StreamLine;
        } catch (err) {
          logger.warn(
            { taskId, err, line: line.slice(0, 200) },
            '[AgentTask] failed to parse stream-json line',
          );
          continue;
        }

        // The CLI announces the session on its opening line (`system`/`init`),
        // long before the `result` line the session id is normally read from.
        // Recording it on the state as we go is what lets a *stopped* task be
        // resumed — including when stopTask has to give up on this loop ever
        // ending and finalize the state itself. drainTask only exposes it once
        // the task is complete, so an in-flight poll is unaffected.
        if (typeof parsed.session_id === 'string') state.sessionId = parsed.session_id;

        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              assistantTexts.push(block.text);
              appendBuffer(state, block.text);
              this.notify(entry);
            }
          }
        } else if (parsed.type === 'result') {
          resultLine = parsed;
        }
      }
    }

    // Wait for the process to actually exit (stdout closing doesn't always
    // mean the child is fully reaped).
    const exitCode: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      // A child that failed to spawn has already emitted its one 'error' event,
      // and will never emit 'exit' — without this the wait below never settles
      // and the task holds a concurrency slot for the life of the process.
      if (entry.spawnError) return resolve(null);
      child.once('exit', (code) => resolve(typeof code === 'number' ? code : null));
      child.once('error', () => resolve(null));
    });

    const cli = finalizeCliResult(resultLine, assistantTexts, stderrChunks.join('\n'), exitCode);
    if (entry.spawnError && !resultLine) {
      // It never ran, so "exited with code N" would be a fiction.
      cli.result = `Claude Code failed to start: ${entry.spawnError.message}`;
      cli.stopReason = 'error';
    }
    if (entry.stopping) {
      // We are why it died, so don't read the signal exit code as a failure.
      // Keep whatever text it managed to produce.
      cli.stopReason = 'stopped';
      cli.result =
        assistantTexts.length > 0
          ? assistantTexts.join('\n\n')
          : 'Task stopped before producing any output.';
    }

    state.completed = true;
    state.result = cli.result;
    state.turns = cli.turns;
    state.stopReason = cli.stopReason;
    // The result line is authoritative when it carries one; otherwise keep the
    // id recorded off an earlier line.
    state.sessionId = cli.sessionId ?? state.sessionId;

    this.notify(entry);
    logger.info({ taskId, stopReason: cli.stopReason, turns: cli.turns }, '[AgentTask] completed');
  }
}

/**
 * SIGTERM, then escalate to SIGKILL if the child is still alive — the same
 * two-stage shape `shell_exec` uses for its timeout and cancel paths.
 */
function terminateChild(child: ChildProcess | undefined, taskId: string): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch (err) {
    logger.warn({ err, taskId }, '[AgentTask] SIGTERM failed');
    return;
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        logger.warn({ err, taskId }, '[AgentTask] SIGKILL failed');
      }
    }
  }, STOP_GRACE_MS).unref();
}

function buildCliCommand(params: AgentTaskParams): {
  command: string;
  args: string[];
} {
  const command = params.agentCommand ?? 'claude';
  const maxTurns = params.maxTurns ?? 100;
  const args: string[] = [
    '-p',
    params.prompt,
    '--output-format',
    'stream-json',
    '--verbose', // required with --output-format stream-json + -p
    '--max-turns',
    String(maxTurns),
  ];

  // The outer tool-risk gate can only assess the delegation call itself, not
  // each action Claude Code takes after it starts. In enforce mode, delegate
  // those nested checks to Claude Code's auto-mode classifier and never retain
  // the permissions bypass. Plan mode is already more restrictive, so keep it
  // in plan without making bypass permissions available.
  if (config.toolRiskGateMode === 'enforce') {
    args.push('--permission-mode', params.mode === 'plan' ? 'plan' : 'auto');
  } else {
    // Preserve existing behavior in off/observe mode. Observe mode promises to
    // measure policy decisions without changing whether calls execute.
    args.push('--dangerously-skip-permissions');
    if (params.mode === 'plan') {
      args.push('--permission-mode', 'plan');
    }
  }

  // Always append, never replace: --system-prompt would substitute Claude Code's
  // default harness (tool selection, todo discipline, search conventions), which is
  // what a plan-mode delegation most needs. Both the plan constraint and a caller's
  // own framing ride one flag, so neither can drop the other.
  const appended = [
    params.mode === 'plan' ? PLAN_ONLY_INSTRUCTION : undefined,
    params.appendSystemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (appended) {
    args.push('--append-system-prompt', appended);
  }
  if (params.sessionId) {
    args.push('--resume', params.sessionId);
  }
  args.push('--disallowed-tools', 'AskUserQuestion');
  if (params.debug) args.push('--debug');

  return { command, args };
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
    output,
    completed: state.completed,
    result: state.completed ? state.result : undefined,
    turns: state.completed ? state.turns : undefined,
    stopReason: state.completed ? state.stopReason : undefined,
    sessionId: state.completed ? state.sessionId : undefined,
  };
}

function finalizeCliResult(
  resultLine: StreamLine | null,
  assistantTexts: string[],
  stderr: string,
  exitCode: number | null,
): CliResult {
  if (resultLine) {
    const subtype = resultLine.subtype ?? 'error';
    const stopReason =
      subtype === 'success'
        ? 'end_turn'
        : subtype === 'error_max_turns'
          ? 'max_turns'
          : 'error';

    const fullText = assistantTexts.length > 0 ? assistantTexts.join('\n\n') : undefined;

    const resultText =
      subtype === 'success'
        ? (fullText ?? resultLine.result ?? '')
        : fullText
          ? `${fullText}\n\n[${subtype}]: ${resultLine.result ?? subtype}`
          : `Error (${subtype}): ${resultLine.result ?? subtype}`;

    return {
      result: resultText,
      turns: resultLine.num_turns ?? 0,
      stopReason,
      sessionId: resultLine.session_id,
    };
  }

  const code = exitCode ?? 1;
  const fullText =
    assistantTexts.length > 0
      ? assistantTexts.join('\n\n')
      : stderr.length > 0
        ? `Agent CLI exited with code ${code}: ${stderr}`
        : `Agent CLI exited with code ${code} and no result`;
  return {
    result: fullText,
    turns: 0,
    stopReason: 'error',
    sessionId: undefined,
  };
}

// Singleton for the MCP tool to share across tool calls.
let singleton: AgentTaskManager | null = null;
export function getAgentTaskManager(): AgentTaskManager {
  if (!singleton) singleton = new AgentTaskManager();
  return singleton;
}

/** Test-only: replace the singleton with a manager that uses a stub spawner. */
export function __setAgentTaskManagerForTests(manager: AgentTaskManager | null): void {
  singleton = manager;
}
