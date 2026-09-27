/**
 * The conversation on screen, as a list the chat surface renders.
 *
 * A conversation is ordered by `createdAt`, then by `id`, the order the runtime
 * keeps. Lines only this client has, its notices and the messages the runtime
 * has not confirmed yet, are `local`. A stored message is ordered against the
 * stored messages only, so a local clock that differs from the runtime's
 * cannot reorder what the person already saw.
 */

import type { TuiMessage } from './tui-adapter.js';

export interface ChatEntry {
  kind: 'message';
  message: TuiMessage;
  /** Drawn by this client and not (yet) stored by the runtime. */
  local?: boolean;
  /** Why the runtime refused this message. It is not sent again. */
  failed?: string;
}

function before(a: TuiMessage, b: TuiMessage): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

function insertInOrder(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  let at = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const other = entries[i]!;
    if (other.local) continue;
    if (!before(entry.message, other.message)) break;
    at = i;
  }
  return [...entries.slice(0, at), entry, ...entries.slice(at)];
}

/**
 * Add a message, or replace the one with its id. A stored message replaces
 * another stored copy where it stands; the stored copy of a message drawn
 * locally takes its ordered place instead, so a message another person sent
 * first appears first here too.
 */
export function upsertMessage(entries: ChatEntry[], message: TuiMessage): ChatEntry[] {
  const at = entries.findIndex((e) => e.message.id === message.id);
  if (at === -1) return insertInOrder(entries, { kind: 'message', message });
  if (entries[at]!.local) {
    return insertInOrder([...entries.slice(0, at), ...entries.slice(at + 1)], { kind: 'message', message });
  }
  const next = entries.slice();
  next[at] = { kind: 'message', message };
  return next;
}

/** Draw a line only this client has: a notice, or a message not yet confirmed. */
export function appendLocal(entries: ChatEntry[], message: TuiMessage): ChatEntry[] {
  return [...entries, { kind: 'message', message, local: true }];
}

/** The stored history in place of the stored messages on screen, keeping the local lines it does not contain. */
export function withHistory(entries: ChatEntry[], history: TuiMessage[]): ChatEntry[] {
  const stored = new Set(history.map((m) => m.id));
  const sorted = [...history].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  let next: ChatEntry[] = sorted.map((message) => ({ kind: 'message', message }));
  for (const entry of entries) {
    if (entry.local && !stored.has(entry.message.id)) next = insertInOrder(next, entry);
  }
  return next;
}

/** Mark a message the runtime refused. */
export function markFailed(entries: ChatEntry[], messageId: string, reason: string): ChatEntry[] {
  return entries.map((e) => (e.message.id === messageId ? { ...e, failed: reason } : e));
}
