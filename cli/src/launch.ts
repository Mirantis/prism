/**
 * How `prism` starts: the conversation the launch flags name, resolved against
 * the runtime before the first frame, so an error prints and exits like any
 * command-line error.
 */

import type { ThreadMode } from './chat-protocol.js';
import type { ContextUsage, ThreadSummary } from './tui-adapter.js';

/** What the command line asks for. Arguments it does not know are left alone. */
export type LaunchArgs =
  | { kind: 'new' }
  | { kind: 'pick' }
  | { kind: 'thread'; id: string }
  | { kind: 'continue' }
  | { kind: 'invalid'; message: string };

export function parseLaunchArgs(args: string[]): LaunchArgs {
  const resumeAt = args.indexOf('--resume');
  const continues = args.includes('--continue');
  if (resumeAt !== -1 && continues) return { kind: 'invalid', message: 'Use --resume or --continue, not both.' };
  if (continues) return { kind: 'continue' };
  if (resumeAt === -1) return { kind: 'new' };
  const id = args[resumeAt + 1];
  return id && !id.startsWith('-') ? { kind: 'thread', id } : { kind: 'pick' };
}

/** What the launch needs from the runtime. Each answer is undefined while the runtime does not answer. */
export interface LaunchRuntime {
  threadMode(): Promise<ThreadMode | undefined>;
  threadStatus(id: string): Promise<'found' | 'missing' | undefined>;
  listSessions(workspaceRoot: string): Promise<ThreadSummary[] | undefined>;
}

/** A conversation to open at start, with its last context reading when the launch has one. */
export interface OpenThread {
  id: string;
  contextUsage: ContextUsage | null;
}

/**
 * What to open at start: a named thread; the session's own conversation, which
 * is the agent's one conversation in single-thread mode; or an error to exit with.
 */
export type Launch = ({ kind: 'thread' } & OpenThread) | { kind: 'session' } | { kind: 'exit'; message: string };

/** How long to wait before asking a runtime that did not answer again. */
const RUNTIME_RETRY_MS = 2_000;

/**
 * Ask until the runtime answers. A terminal that restores its tabs can start
 * `prism` before the runtime it connects to, so a missing answer is not an error.
 * `onWait` runs once, before the first wait.
 */
export async function untilAnswered<T>(ask: () => Promise<T | undefined>, onWait: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const answer = await ask();
    if (answer !== undefined) return answer;
    if (attempt === 0) onWait();
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_RETRY_MS));
  }
}

/**
 * The conversation `--resume <id>` names, or the error when the runtime has none
 * with that id. An agent in single-thread mode opens its one conversation, as a
 * bare `--resume` does.
 */
export async function resolveThreadLaunch(id: string, runtime: LaunchRuntime, onWait: () => void): Promise<Launch> {
  const wait = once(onWait);
  const mode = await untilAnswered(() => runtime.threadMode(), wait);
  if (mode === 'single') return { kind: 'session' };
  const status = await untilAnswered(() => runtime.threadStatus(id), wait);
  if (status === 'missing') return { kind: 'exit', message: `No conversation with id ${id}.` };
  return { kind: 'thread', id, contextUsage: null };
}

/**
 * The conversation `--continue` opens: the most recently updated one started in
 * `cwd`, or the error when there is none. An agent in single-thread mode opens
 * its one conversation.
 *
 * The runtime lists a directory's 50 newest conversations by creation time, so a
 * directory with more than 50 can miss an older one updated since. That is the
 * trade for a lookup that needs no other runtime route.
 */
export async function resolveContinueLaunch(cwd: string, runtime: LaunchRuntime, onWait: () => void): Promise<Launch> {
  const wait = once(onWait);
  const mode = await untilAnswered(() => runtime.threadMode(), wait);
  if (mode === 'single') return { kind: 'session' };
  const sessions = await untilAnswered(() => runtime.listSessions(cwd), wait);
  // A runtime older than the `workspaceRoot` query lists every directory's threads.
  const latest = latestUpdated(sessions.filter((session) => session.workspaceRoot === cwd));
  if (!latest) return { kind: 'exit', message: `No conversation to continue in ${cwd}.` };
  return { kind: 'thread', id: latest.id, contextUsage: latest.contextUsage };
}

/** The most recently updated conversation, the first listed on a tie. */
export function latestUpdated(sessions: ThreadSummary[]): ThreadSummary | undefined {
  let latest: ThreadSummary | undefined;
  for (const session of sessions) {
    if (!latest || Date.parse(session.updatedAt) > Date.parse(latest.updatedAt)) latest = session;
  }
  return latest;
}

/** `fn`, run on its first call only: one wait notice for a launch that asks several questions. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
