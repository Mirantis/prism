/**
 * The compacted-history tool — reads the messages a compaction summary replaced.
 *
 * A summary keeps what a later turn most likely needs; this tool returns the exact
 * words when it does not. The rows stay in the database after a compaction, marked
 * `isCompacted`, so nothing is lost, only out of the context.
 *
 * Bound to the turn's thread: the model cannot name another conversation.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { conversationService, type CompactedMessage } from '../services/conversation.service';
import { toolOutputPath } from '../lib/tool-output-store';

export const COMPACTED_HISTORY_TOOL_NAME = 'read_compacted_history';

const PAGE_SIZE = 20;

/**
 * The text a page may hold, under the 30,000-character tool budget: a page cut by
 * that budget would hide messages its next offset skips.
 */
const PAGE_CHARS = 20_000;

/**
 * Each message text, tool input and tool result in a page is cut to this many
 * characters, around the query's match when there is one, so every page fits the
 * budget. A read of one message by position is cut by `PAGE_CHARS` alone.
 */
const OUTPUT_CHARS = 2_000;

export function getConversationHistoryTools(threadId: string, workspaceRoot?: string): Record<string, Tool> {
  return {
    [COMPACTED_HISTORY_TOOL_NAME]: tool({
      description:
        'Read the earlier messages of this conversation that its summary replaced, oldest first, ' +
        'with their tool calls and results. Use it when you need an exact detail the summary does ' +
        'not give: a command, an error, a value, what the user said word for word. Each message ' +
        'has a position. A page cuts long texts; give a query to see the part around a match. ' +
        'Give a position as offset, without a query, to read from that message onward; a smaller ' +
        'offset reads the messages before it. Give position to read one message in full.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Return only the messages whose text or tool calls contain this, ignoring case.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'How many messages to skip, for the next page. Without a query this is the position of the first message. Default 0.',
          ),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Read the message at this position in full, uncut. Ignores query and offset.'),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('With position: the character to start from, for the next part of a long message. Default 0.'),
      }),
      execute: async ({ query, offset = 0, position, start = 0 }) => {
        if (position !== undefined) return readMessage(threadId, position, start, workspaceRoot);
        const page = await conversationService.listCompactedMessages(threadId, { query, offset, limit: PAGE_SIZE });
        if (page.messages.length === 0) {
          return { messages: [], note: offset > 0 ? 'No more messages.' : 'No earlier message matches.' };
        }
        const entries: Record<string, unknown>[] = [];
        let chars = 0;
        for (const message of page.messages) {
          const entry = toEntry(message, query, workspaceRoot);
          chars += JSON.stringify(entry).length;
          if (entries.length > 0 && chars > PAGE_CHARS) break;
          entries.push(entry);
        }
        const more = page.more || entries.length < page.messages.length;
        return { messages: entries, ...(more ? { nextOffset: offset + entries.length } : {}) };
      },
    }),
  };
}

/** One message as one text, every part uncut, read `PAGE_CHARS` at a time from `start`. */
async function readMessage(threadId: string, position: number, start: number, workspaceRoot: string | undefined) {
  const message = await conversationService.getCompactedMessage(threadId, position);
  if (!message) return { note: `No earlier message at position ${position}.` };
  const text = fullText(message, workspaceRoot);
  const part = text.slice(start, start + PAGE_CHARS);
  const next = start + part.length;
  return {
    position,
    from: authorOf(message),
    at: message.createdAt.toISOString(),
    characters: text.length,
    start,
    text: part,
    ...(next < text.length ? { nextStart: next } : {}),
  };
}

function fullText(message: CompactedMessage, workspaceRoot: string | undefined): string {
  const parts = [message.content];
  for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
    const { tool: name, input, output, truncated } = (call ?? {}) as StoredCall;
    parts.push(
      `[Tool call: ${name}]`,
      `[Input]\n${typeof input === 'string' ? input : JSON.stringify(input ?? null)}`,
      `[Output]\n${typeof output === 'string' ? output : JSON.stringify(output ?? null, null, 2)}`,
      ...(truncated?.spillId ? [`[Saved whole result: ${toolOutputPath(truncated.spillId, workspaceRoot)}]`] : []),
    );
  }
  return parts.join('\n\n');
}

/** A user row that is an internal step holds context the runtime added, such as recalled memories. */
function authorOf(message: CompactedMessage): string {
  if (message.role === 'USER') return message.internalStep ? 'context' : 'user';
  return message.role === 'AGENT' ? 'you' : 'system';
}

function toEntry(message: CompactedMessage, query: string | undefined, workspaceRoot: string | undefined): Record<string, unknown> {
  const cut = (text: unknown, needle: string | undefined) => clip(text, needle, message.position);
  return {
    position: message.position,
    from: authorOf(message),
    at: message.createdAt.toISOString(),
    text: cut(message.content, query),
    ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? {
          toolCalls: message.toolCalls.map((call) => {
            const { tool: name, input, output, truncated } = (call ?? {}) as StoredCall;
            return {
              tool: name,
              input: typeof input === 'string' ? cut(input, query) : clipJson(input, query, message.position),
              output: cut(output, query),
              // The saved whole result, which the shell reads; its notice in `output` may be cut away.
              ...(truncated?.spillId ? { savedAt: toolOutputPath(truncated.spillId, workspaceRoot) } : {}),
            };
          }),
        }
      : {}),
  };
}

interface StoredCall {
  tool?: string;
  input?: unknown;
  output?: unknown;
  truncated?: { spillId?: string };
}

/** A tool input given as an object, cut as text when its JSON is long, around the query as JSON writes it. */
function clipJson(input: unknown, query: string | undefined, position: number): unknown {
  if (input === undefined) return input;
  const json = JSON.stringify(input);
  return json.length <= OUTPUT_CHARS ? input : clip(json, query && JSON.stringify(query).slice(1, -1), position);
}

/** The first `OUTPUT_CHARS` of a long text, or the window around the query's first match in it. */
function clip(output: unknown, query: string | undefined, position: number): unknown {
  if (typeof output !== 'string' || output.length <= OUTPUT_CHARS) return output;
  const match = query ? output.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = match > OUTPUT_CHARS / 2 ? Math.min(match - OUTPUT_CHARS / 4, output.length - OUTPUT_CHARS) : 0;
  const shown = output.slice(start, start + OUTPUT_CHARS);
  return (
    `${start > 0 ? `[From character ${start}.]\n` : ''}${shown}\n` +
    `[Cut: ${OUTPUT_CHARS} of ${output.length} characters shown. Call with position ${position} to read this message in full.]`
  );
}
