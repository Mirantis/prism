/**
 * The request and thread the model calls of a piece of work belong to, and what
 * started that work.
 *
 * A chat turn and an autonomous run set it once at their entry, and
 * `llmCallService.record` reads it, so a gate or a compaction deep inside the
 * work is attributed without passing an id through every call site. Work started
 * inside the context inherits it, as `AsyncLocalStorage` does.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What starts a request: a person's message, or one of the agent's own triggers. */
export type SpendSourceKind = 'chat' | 'heartbeat' | 'cron' | 'webhook' | 'goal' | 'voice-chat' | 'meeting' | 'dictation';

export const SPEND_SOURCE_KINDS: readonly SpendSourceKind[] = [
  'chat',
  'heartbeat',
  'cron',
  'webhook',
  'goal',
  'voice-chat',
  'meeting',
  'dictation',
];

export interface SpendSource {
  kind: SpendSourceKind;
  /** The scheduled task, webhook or goal, where the kind has one. */
  id?: string;
}

export interface SpendContext {
  /** The id the work's calls are grouped by: the user message a chat turn answers, or the run's own id. */
  requestId: string;
  threadId?: string;
  source?: SpendSource;
}

const storage = new AsyncLocalStorage<SpendContext>();

export function withSpendContext<T>(context: SpendContext, run: () => T): T {
  return storage.run(context, run);
}

export function currentSpendContext(): SpendContext | undefined {
  return storage.getStore();
}
