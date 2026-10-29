import type { TaskLastSend } from '../types';

/**
 * The user message of a scheduled run that continues no conversation: the
 * task's instruction, then a reminder that only a post reaches anyone. An
 * instruction written as steps that end in "reply with X" reads as a request
 * for a final message, and the reminder sits right after it. A run that has a
 * send record is also told to read it first, because a conditional finding that
 * holds on every run reads as a request for a post on every run.
 */
export function scheduledRunPrompt(instruction: string, lastSend?: TaskLastSend): string {
  const record = lastSend ? ' Before you post, read "Messages This Task Sent".' : '';
  return `${instruction}\n\n(Scheduled run: only what you post with send_message reaches anyone. A reply, a report or a message the instruction asks for is a post.${record})`;
}
