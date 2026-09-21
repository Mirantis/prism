/**
 * Run a coding agent's CLI as one `CodingAgentRun`.
 *
 * Shared plumbing for the adapters whose agent is a command-line program: start
 * it in the execution environment, turn each stdout line into events through
 * the adapter's parser, wait for it to exit, and close the stream with a
 * `result` when the agent reported none. The contract in `coding-agent.ts`
 * knows nothing of this; an adapter that is not a CLI builds its run another
 * way.
 */

import { createInterface } from 'readline';
import { logger } from '../../logger';
import { AsyncChannel } from '../../utils/async-channel';
import { getExecutionEnvironment } from '../execution-environments/get-execution-environment';
import type {
  ExecProcess,
  ExecutionEnvironment,
} from '../execution-environments/execution-environment';
import type { CodingAgentEvent, CodingAgentRun } from './coding-agent';

/** How long a stopped process gets to honour SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 2_000;

/** How much of stderr is kept for the closing message of a run that reports nothing. */
export const STDERR_KEEP_BYTES = 4096;

export interface CliRunSpec {
  taskId: string;
  /** Names the agent in the closing message of a run that never got to report. */
  displayName: string;
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /**
   * One stdout line to events; `[]` for a line of no interest. Throws on a line
   * it cannot read, which is logged and skipped.
   */
  parseLine(line: string): CodingAgentEvent[];
}

export function runCli(
  spec: CliRunSpec,
  environment: ExecutionEnvironment = getExecutionEnvironment(),
): CodingAgentRun {
  const { taskId } = spec;
  // An environment has no ambient working directory of its own, so a spec that
  // names none runs at the workspace root.
  const proc = environment.runProgram(spec.command, spec.args, {
    cwd: spec.cwd ?? environment.workspaceRoot(),
    env: spec.env,
    stdin: 'pipe',
  });
  // Prompts are argv inputs; Codex also reads piped stdin until EOF.
  proc.stdin?.end();
  const events = new AsyncChannel<CodingAgentEvent>();

  const pump = async (): Promise<void> => {
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    if (proc.stderr) {
      const stderrReader = createInterface({ input: proc.stderr });
      stderrReader.on('line', (line) => {
        logger.debug({ taskId, line }, '[AgentTask] stderr');
        if (stderrBytes < STDERR_KEEP_BYTES) {
          const kept = line.slice(0, STDERR_KEEP_BYTES - stderrBytes);
          stderrChunks.push(kept);
          stderrBytes += kept.length + 1;
        }
      });
    }

    let reported = false;
    if (proc.stdout) {
      const stdoutReader = createInterface({ input: proc.stdout });
      for await (const line of stdoutReader) {
        if (line.length === 0) continue;
        let parsed: CodingAgentEvent[];
        try {
          parsed = spec.parseLine(line);
        } catch (err) {
          logger.warn({ taskId, err, line: line.slice(0, 200) }, '[AgentTask] unreadable output line');
          continue;
        }
        for (const event of parsed) {
          if (event.type === 'result') reported = true;
          events.push(event);
        }
      }
    }

    // Wait for the process to actually exit (stdout closing doesn't always
    // mean the process is fully reaped).
    const end = await proc.ended;
    // A launch failure — a missing binary, a workdir that doesn't exist — never
    // reaches the parser, so it is reported here and as the closing result.
    if (end.error) logger.error({ err: end.error, taskId }, '[AgentTask] child process error');

    if (!reported) {
      events.push({
        type: 'result',
        stopReason: 'error',
        turns: 0,
        message: closingMessage(spec.displayName, end.error, end.exitCode, stderrChunks.join('\n')),
      });
    }
    events.close();
  };

  // Rejections are logged here because nothing awaits the pump: the consumer
  // reads the channel, which a failed pump would otherwise leave open forever.
  pump().catch((err) => {
    logger.error({ err, taskId }, '[AgentTask] output pump failed');
    events.close();
  });

  return {
    events,
    get exited(): boolean {
      return proc.exitCode !== null || proc.signal !== null;
    },
    stop: () => terminate(proc, taskId),
  };
}

/** The `result` message for a run that ended without the agent reporting one. */
function closingMessage(
  displayName: string,
  launchError: Error | null,
  exitCode: number | null,
  stderr: string,
): string {
  // It never ran, so "exited with code N" would be a fiction.
  if (launchError) return `${displayName} failed to start: ${launchError.message}`;
  const code = exitCode ?? 1;
  return stderr.length > 0
    ? `${displayName} exited with code ${code}: ${stderr}`
    : `${displayName} exited with code ${code} and no result`;
}

/**
 * SIGTERM, then escalate to SIGKILL if the process is still alive — the same
 * two-stage shape `shell_exec` uses for its timeout and cancel paths.
 */
function terminate(proc: ExecProcess, taskId: string): void {
  if (!proc.kill('SIGTERM')) {
    logger.warn({ taskId }, '[AgentTask] SIGTERM was not delivered');
    return;
  }
  setTimeout(() => {
    if (proc.exitCode === null && proc.signal === null) {
      if (!proc.kill('SIGKILL')) logger.warn({ taskId }, '[AgentTask] SIGKILL was not delivered');
    }
  }, STOP_GRACE_MS).unref();
}
