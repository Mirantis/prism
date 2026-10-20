/**
 * A coding agent's run whose process starts once some work before it is done.
 */

import { logger } from '../../logger';
import { AsyncChannel } from '../../utils/async-channel';
import type { CodingAgentEvent, CodingAgentRun } from './coding-agent';

/**
 * The run that `start` returns, as one `CodingAgentRun` from the moment it is
 * asked for. A stop before `start` settles aborts its signal. A rejection is the
 * run's closing `result`, as a launch failure is.
 */
export function deferredRun(
  taskId: string,
  displayName: string,
  start: (signal: AbortSignal) => Promise<CodingAgentRun>,
): CodingAgentRun {
  const events = new AsyncChannel<CodingAgentEvent>();
  const abort = new AbortController();
  let run: CodingAgentRun | null = null;
  let ended = false;
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const pump = async (): Promise<void> => {
    run = await start(abort.signal);
    void run.started.then(markStarted);
    if (abort.signal.aborted) run.stop();
    for await (const event of run.events) events.push(event);
  };

  pump()
    .catch((err: unknown) => {
      if (abort.signal.aborted) {
        events.push({ type: 'result', stopReason: 'error', turns: 0, message: `${displayName} was stopped before it started` });
        return;
      }
      logger.error({ err, taskId }, '[AgentTask] coding task failed to start');
      const reason = err instanceof Error ? err.message : String(err);
      events.push({ type: 'result', stopReason: 'error', turns: 0, message: `${displayName} failed to start: ${reason}` });
    })
    .finally(() => {
      ended = true;
      events.close();
    });

  return {
    events,
    get exited(): boolean {
      return run ? run.exited : ended;
    },
    get mark() {
      return run?.mark;
    },
    started,
    stop: () => {
      abort.abort();
      run?.stop();
    },
  };
}
