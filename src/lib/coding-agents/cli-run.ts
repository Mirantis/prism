/**
 * Run a coding agent's CLI as one `CodingAgentRun`.
 *
 * Shared plumbing for the adapters whose agent is a command-line program: spawn
 * it, turn each stdout line into events through the adapter's parser, wait for
 * it to exit, and close the stream with a `result` when the agent reported
 * none. The contract in `coding-agent.ts` knows nothing of this; an adapter
 * that is not a CLI builds its run another way.
 */

import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { logger } from '../../logger';
import { AsyncChannel } from '../../utils/async-channel';
import type { CodingAgentEvent, CodingAgentRun } from './coding-agent';

/** How long a stopped child gets to honour SIGTERM before SIGKILL. */
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

/** `spawn`-shaped hook so tests can stand in a fake child for the real binary. */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export function runCli(spec: CliRunSpec, spawner: Spawner = spawn): CodingAgentRun {
  const { taskId } = spec;
  const child = spawner(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
  // Prompts are argv inputs; Codex also reads piped stdin until EOF.
  child.stdin?.end();
  const events = new AsyncChannel<CodingAgentEvent>();

  // A spawn failure — a missing binary, a workdir that doesn't exist — emits
  // 'error' at once, before the pump below gets as far as attaching its own
  // listener. Unhandled, that event takes the whole runtime down, so claim it
  // here and let the closing result report it as a failed run.
  let spawnError: Error | undefined;
  child.once('error', (err: Error) => {
    spawnError = err;
    logger.error({ err, taskId }, '[AgentTask] child process error');
  });

  // Attach before reading stdout: a signal exit can precede the last pipe close.
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : null));
    child.once('error', () => resolve(null));
  });

  const pump = async (): Promise<void> => {
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    if (child.stderr) {
      const stderrReader = createInterface({ input: child.stderr });
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
    if (child.stdout) {
      const stdoutReader = createInterface({ input: child.stdout });
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
    // mean the child is fully reaped).
    const exitCode = await exited;

    if (!reported) {
      events.push({
        type: 'result',
        stopReason: 'error',
        turns: 0,
        message: closingMessage(spec.displayName, spawnError, exitCode, stderrChunks.join('\n')),
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
      return child.exitCode !== null || child.signalCode !== null;
    },
    stop: () => terminateChild(child, taskId),
  };
}

/** The `result` message for a run that ended without the agent reporting one. */
function closingMessage(
  displayName: string,
  spawnError: Error | undefined,
  exitCode: number | null,
  stderr: string,
): string {
  // It never ran, so "exited with code N" would be a fiction.
  if (spawnError) return `${displayName} failed to start: ${spawnError.message}`;
  const code = exitCode ?? 1;
  return stderr.length > 0
    ? `${displayName} exited with code ${code}: ${stderr}`
    : `${displayName} exited with code ${code} and no result`;
}

/**
 * SIGTERM, then escalate to SIGKILL if the child is still alive — the same
 * two-stage shape `shell_exec` uses for its timeout and cancel paths.
 */
function terminateChild(child: ChildProcess, taskId: string): void {
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
