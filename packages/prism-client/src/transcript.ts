import type { ConversationMessage } from './types.js';

/** A row in the chat: a stored message, or one of ours the runtime has not stored yet. */
export interface TranscriptMessage extends ConversationMessage {
  /** Set only on a message of ours that the runtime has not stored. */
  delivery?: 'sending' | 'failed';
  /** Why a failed message was not stored, written for a person. */
  deliveryError?: string;
}

/** The order every client keeps: oldest first, a tie broken by id. */
export function compareMessages(a: ConversationMessage, b: ConversationMessage): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Put a message in its place, replacing an earlier copy with the same id. */
export function upsertMessage(
  messages: readonly ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  return [...messages.filter((m) => m.id !== message.id), message].sort(compareMessages);
}

/**
 * A line this page wrote itself — "Response stopped", a command's result, a failed
 * turn's error. It is placed after the stored message that was last when it was
 * written, never by its timestamp: that is this browser's clock, and the runtime's
 * can be seconds apart.
 */
export interface TranscriptNote extends ConversationMessage {
  /** The stored message it follows, or null when the thread had none yet. */
  after: string | null;
}

/**
 * What a thread shows: its stored messages in order with this page's notes where
 * they were written, then our messages that are not stored yet. A pending message
 * stays last until its own copy arrives, for the same reason a note is not sorted.
 */
export function buildTranscript(
  stored: readonly ConversationMessage[],
  notes: readonly TranscriptNote[],
  pending: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const ordered = [...stored].sort(compareMessages);
  const storedIds = new Set(ordered.map((m) => m.id));
  const following = new Map<string | null, TranscriptNote[]>();
  for (const note of notes) {
    // A note whose message is gone, compacted or reloaded away, stays at the end.
    const anchor = note.after === null || storedIds.has(note.after) ? note.after : ordered.at(-1)?.id ?? null;
    following.set(anchor, [...(following.get(anchor) ?? []), note]);
  }
  return [
    ...(following.get(null) ?? []),
    ...ordered.flatMap((m) => [m, ...(following.get(m.id) ?? [])]),
    ...pending.filter((m) => !storedIds.has(m.id)),
  ];
}
