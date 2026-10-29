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

/** Each tool result in a page is cut to this many characters, around the query's match when there is one. */
const OUTPUT_CHARS = 2_000;

export function getConversationHistoryTools(threadId: string, workspaceRoot?: string): Record<string, Tool> {
  return {
    [COMPACTED_HISTORY_TOOL_NAME]: tool({
      description:
        'Read the earlier messages of this conversation that its summary replaced, oldest first, ' +
        'with their tool calls and results. Use it when you need an exact detail the summary does ' +
        'not give: a command, an error, a value, what the user said word for word.',
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
          .describe('How many matching messages to skip, for the next page. Default 0.'),
      }),
      execute: async ({ query, offset = 0 }) => {
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

/** A user row that is an internal step holds context the runtime added, such as recalled memories. */
function authorOf(message: CompactedMessage): string {
  if (message.role === 'USER') return message.internalStep ? 'context' : 'user';
  return message.role === 'AGENT' ? 'you' : 'system';
}

function toEntry(message: CompactedMessage, query: string | undefined, workspaceRoot: string | undefined): Record<string, unknown> {
  return {
    from: authorOf(message),
    at: message.createdAt.toISOString(),
    text: message.content,
    ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? {
          toolCalls: message.toolCalls.map((call) => {
            const { tool: name, input, output, truncated } = (call ?? {}) as StoredCall;
            return {
              tool: name,
              input,
              output: clip(output, query),
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

/** The first `OUTPUT_CHARS` of a long result, or the window around the query's first match in it. */
function clip(output: unknown, query: string | undefined): unknown {
  if (typeof output !== 'string' || output.length <= OUTPUT_CHARS) return output;
  const match = query ? output.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = match > OUTPUT_CHARS / 2 ? Math.min(match - OUTPUT_CHARS / 4, output.length - OUTPUT_CHARS) : 0;
  const shown = output.slice(start, start + OUTPUT_CHARS);
  return `${start > 0 ? `[From character ${start}.]\n` : ''}${shown}\n[${OUTPUT_CHARS} of ${output.length} characters shown.]`;
}
