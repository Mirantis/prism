/**
 * How `prism` starts: the conversation the launch flags name, resolved against
 * the runtime before the first frame, so an error prints and exits like any
 * command-line error.
 */

import type { ThreadMode } from './chat-protocol.js';

/** What the command line asks for. Arguments it does not know are left alone. */
export type LaunchArgs =
  | { kind: 'new' }
  | { kind: 'pick' }
  | { kind: 'thread'; id: string };

export function parseLaunchArgs(args: string[]): LaunchArgs {
  const resumeAt = args.indexOf('--resume');
  if (resumeAt === -1) return { kind: 'new' };
  const id = args[resumeAt + 1];
  return id && !id.startsWith('-') ? { kind: 'thread', id } : { kind: 'pick' };
}

/** What the launch needs from the runtime. Each answer is undefined while the runtime does not answer. */
export interface LaunchRuntime {
  threadMode(): Promise<ThreadMode | undefined>;
  threadStatus(id: string): Promise<'found' | 'missing' | undefined>;
}

/** A conversation to open at start. */
export interface OpenThread {
  id: string;
}

/**
 * What to open at start: a named thread; the session's own conversation, which
 * is the agent's one conversation in single-thread mode; or an error to exit with.
 */
export type Launch = ({ kind: 'thread' } & OpenThread) | { kind: 'session' } | { kind: 'exit'; message: string };

/** How long to wait before asking a runtime that did not answer again. */
export const RUNTIME_RETRY_MS = 2_000;

/**
 * Ask until the runtime answers. A terminal that restores its tabs can start
 * `prism` before the runtime it connects to, so a missing answer is not an error.
 * `onWait` runs once, before the first wait.
 */
export async function untilAnswered<T>(
  ask: () => Promise<T | undefined>,
  onWait: () => void,
  retryMs = RUNTIME_RETRY_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const answer = await ask();
    if (answer !== undefined) return answer;
    if (attempt === 0) onWait();
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * The conversation `--resume <id>` names, or the error when the runtime has none
 * with that id. An agent in single-thread mode opens its one conversation, as a
 * bare `--resume` does.
 */
export async function resolveThreadLaunch(
  id: string,
  runtime: LaunchRuntime,
  onWait: () => void,
  retryMs?: number,
): Promise<Launch> {
  // One wait notice for the whole launch, however many questions it asks.
  let waited = false;
  const wait = () => {
    if (!waited) onWait();
    waited = true;
  };
  const mode = await untilAnswered(() => runtime.threadMode(), wait, retryMs);
  if (mode === 'single') return { kind: 'session' };
  const status = await untilAnswered(() => runtime.threadStatus(id), wait, retryMs);
  if (status === 'missing') return { kind: 'exit', message: `No conversation with id ${id}.` };
  return { kind: 'thread', id };
}
