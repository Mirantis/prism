/**
 * Agent task manager for `claude_code` / `claude_code_status`.
 *
 * TypeScript port of
 * `nexus-monorepo/crates/nexus-shell-sandbox/src/agent_task_manager.rs`.
 * Spawns the Claude Code CLI with `--output-format stream-json`,
 * parses the NDJSON stream, buffers assistant text for drain-on-read
 * polling, and tracks completion state.
 *
 * Designed for single-agent-mode: one in-process manager per
 * agent-runtime, at most MAX_CONCURRENT tasks running at once. The
 * agent invokes `startTask()` via the `claude_code` MCP tool and
 * polls via `readStatus()` from `claude_code_status`.
 */
import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { logger } from '../../logger';

export const MAX_CONCURRENT = 3;
export const DEFAULT_WAIT_MS = 5_000;
export const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MiB

const PLAN_ONLY_SYSTEM_PROMPT =
  'You are in plan-only mode. Analyze, explore, and create a detailed plan. Do not create or modify any files. Return your plan as your final text response.';

export interface AgentTaskParams {
  prompt: string;
  workdir?: string;
  systemPrompt?: string;
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

  startTask(params: AgentTaskParams): string {
    let running = 0;
    for (const entry of this.tasks.values()) {
      if (!entry.state.completed) running++;
    }
    if (running >= MAX_CONCURRENT) {
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
      env: { ...process.env, ...(params.env ?? {}) } as NodeJS.ProcessEnv,
    });
    entry.child = child;

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

    void this.drive(taskId, entry, child);
    return taskId;
  }

  async readStatus(taskId: string, waitMs?: number): Promise<AgentTaskStatus> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      if (this.reaped.has(taskId)) {
        throw new Error(`Task ${taskId} has already completed and been cleaned up`);
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

    // The entry might have been reaped while we waited.
    const stillThere = this.tasks.get(taskId);
    if (!stillThere) {
      return {
        output: '',
        completed: true,
        stopReason: 'error',
      };
    }
    return this.drainAndMaybeReap(taskId, stillThere);
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
    if (entry.state.completed && !hadOutput) {
      this.tasks.delete(taskId);
      this.reaped.add(taskId);
      // Keep the reaped set from growing without bound.
      if (this.reaped.size > MAX_CONCURRENT * 10) {
        const first = this.reaped.values().next().value;
        if (first !== undefined) this.reaped.delete(first);
      }
    }
    return status;
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
      child.once('exit', (code) => resolve(typeof code === 'number' ? code : null));
      child.once('error', () => resolve(null));
    });

    const cli = finalizeCliResult(resultLine, assistantTexts, stderrChunks.join('\n'), exitCode);

    state.completed = true;
    state.result = cli.result;
    state.turns = cli.turns;
    state.stopReason = cli.stopReason;
    state.sessionId = cli.sessionId;

    this.notify(entry);
    logger.info({ taskId, stopReason: cli.stopReason, turns: cli.turns }, '[AgentTask] completed');
  }
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
    '--dangerously-skip-permissions',
  ];

  const effectiveSystemPrompt =
    params.mode === 'plan' && !params.systemPrompt
      ? PLAN_ONLY_SYSTEM_PROMPT
      : params.systemPrompt;
  if (effectiveSystemPrompt) {
    args.push('--system-prompt', effectiveSystemPrompt);
  }
  if (params.sessionId) {
    args.push('--resume', params.sessionId);
  }
  if (params.mode === 'plan') {
    args.push('--permission-mode', 'plan');
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
