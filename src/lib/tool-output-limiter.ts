/**
 * Tool Output Limiter
 *
 * Wraps MCP tools with a toModelOutput hook that applies head+tail truncation
 * to large tool outputs. This prevents context overflow during generateText()
 * agentic loops while preserving the most useful parts of the output.
 *
 * Strategy:
 * - Keep first 80% of budget (structural headers, column names, initial results)
 * - Keep last 20% of budget (end-of-output, summary lines, final entries)
 * - Replace middle with a message guiding the model to use more targeted queries
 */

import type { Tool } from 'ai';

type ToolResultOutput = { type: 'text'; value: string };

const DEFAULT_MAX_CHARS = 30_000;
const HEAD_RATIO = 0.8;

/**
 * Wrap each tool with a toModelOutput hook that truncates large outputs
 * using head+tail strategy. The raw output from execute() is preserved
 * for logging — only the model-facing view is truncated.
 */
export function withOutputLimits(
  tools: Record<string, Tool>,
  maxChars = DEFAULT_MAX_CHARS
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      toModelOutput: async ({ output }: { output: unknown }): Promise<ToolResultOutput> => {
        const text = stringifyToolOutput(output);
        if (text.length <= maxChars + 500) {
          return { type: 'text', value: text };
        }
        return { type: 'text', value: truncateHeadTail(text, maxChars) };
      },
    };
  }
  return wrapped;
}

/**
 * Truncate text keeping the head and tail portions.
 * SRE tool outputs typically have column headers/structure at the top
 * and summary/status at the bottom.
 */
export function truncateHeadTail(text: string, maxChars: number): string {
  const headSize = Math.floor(maxChars * HEAD_RATIO);
  const tailSize = maxChars - headSize;
  const omitted = text.length - headSize - tailSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  return (
    head +
    `\n\n[... ${omitted} chars omitted — ${text.length} chars total. ` +
    `Use more targeted queries (e.g., filter by namespace, limit output) for complete results.]\n\n` +
    tail
  );
}

/**
 * Convert tool output to a string for the model.
 * Handles plain strings, MCP CallToolResult format, and JSON objects.
 */
export function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  if (isMCPCallToolResult(output)) {
    return output.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && Boolean(c.text))
      .map((c) => c.text)
      .join('\n');
  }
  return JSON.stringify(output);
}

function isMCPCallToolResult(
  o: unknown
): o is { content: Array<{ type: string; text?: string }> } {
  return (
    typeof o === 'object' &&
    o !== null &&
    'content' in o &&
    Array.isArray((o as Record<string, unknown>).content)
  );
}
