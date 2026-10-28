/**
 * The user message of a scheduled run that continues no conversation: the
 * task's instruction, then a reminder that only a post reaches anyone. An
 * instruction written as steps that end in "reply with X" reads as a request
 * for a final message, and the reminder sits right after it.
 */
export function scheduledRunPrompt(instruction: string): string {
  return `${instruction}\n\n(Scheduled run: only what you post with send_message reaches anyone. A reply, a report or a message the instruction asks for is a post.)`;
}
