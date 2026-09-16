/**
 * Message Boundaries
 *
 * The single owner of "two texts that reach the model inside one block are
 * separated".
 *
 * A provider adapter groups a run of adjacent user messages into one API
 * message and emits each text part as its own block, verbatim and with no
 * separator between them. A model reads two such blocks as one piece of prose,
 * so the last word of one joins the first word of the next: a turn ending
 * `...available through Bedrock` followed by a recalled-memory block starting
 * `Context:` was read as `BedrockContext`, and the agent then answered a
 * question about an identifier nobody had written.
 *
 * The runtime appends context to a turn as a user message of its own — the
 * recalled-memory block, a mid-turn steering message, a viewed document, a
 * heartbeat or cron prompt onto a user-terminated history — and renders each
 * attachment as a text part after the user's own text. Every one of those is the
 * same seam, so the boundary is applied once over the assembled array rather
 * than by each injection site.
 *
 * The pass pads the text *before* the seam and never the text after it. So the
 * injected block keeps its own bytes: a recall row is stored and sent as the one
 * string `recalledMemoryContent` builds, and an attachment stub reaches the
 * model with the wording it was written with. What gains a trailing blank line
 * is the predecessor — usually the user's own message — in the model-facing
 * array alone. Nothing stored changes: the pass runs on the array handed to the
 * model call, after history is read and after a recall row is written.
 *
 * Pure and idempotent, so a step boundary that rebuilds and re-normalizes the
 * array produces the same bytes as the initial call and the prompt-cache prefix
 * holds from turn to turn.
 */

import type { ModelMessage, UserModelMessage } from 'ai';

/** What separates two texts that share one provider block. */
const BOUNDARY = '\n\n';

/**
 * Every text that has another text behind it in the same provider block ends
 * with a blank line.
 *
 * Returns a new array; the input and its messages are left as they are, since
 * the caller keeps the same array for the compaction fork and for the
 * early-stopping call.
 */
export function withTextBoundaries(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message, i) => {
    if (message.role !== 'user') return message;
    return separateParts(message, startsWithText(messages[i + 1]));
  });
}

/**
 * Whether a message's first block is a text one, so a text before it would sit
 * next to it.
 *
 * Only a user message continues the run: an assistant turn closes the provider
 * message, and a `tool` message opens with a tool-result block, which is not
 * text and so cannot join the text in front of it.
 */
function startsWithText(message: ModelMessage | undefined): boolean {
  if (message?.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  return message.content[0]?.type === 'text';
}

/**
 * One user message, with a blank line after each of its text parts that another
 * text follows — inside the message, or across the seam to the next message.
 */
function separateParts(message: UserModelMessage, textFollows: boolean): UserModelMessage {
  if (typeof message.content === 'string') {
    if (!textFollows) return message;
    return { ...message, content: endWithBlankLine(message.content) };
  }

  const parts = message.content;
  let changed = false;
  const separated = parts.map((part, i) => {
    if (part.type !== 'text') return part;
    const next = parts[i + 1];
    const followed = next ? next.type === 'text' : textFollows;
    if (!followed) return part;
    const text = endWithBlankLine(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });

  return changed ? { ...message, content: separated } : message;
}

/**
 * Text that ends on a blank line, whatever it ended on before. A text already
 * ending that way is returned as it is, so running the pass twice adds nothing.
 */
function endWithBlankLine(text: string): string {
  if (text.endsWith(BOUNDARY)) return text;
  if (text.endsWith('\n')) return `${text}\n`;
  return `${text}${BOUNDARY}`;
}
