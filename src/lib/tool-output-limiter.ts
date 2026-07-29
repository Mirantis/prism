/**
 * Tool Output Limiter
 *
 * The single owner of "render a tool result for a model, and cut it if it is too
 * big". Both paths that hand a tool result to a model use it:
 *
 * - the invoke loop (chat, heartbeat, cron, goals, subagents) via
 *   `withOutputLimits`, which installs a `toModelOutput` hook per tool;
 * - a live voice meeting via `renderToolResult` in
 *   `services/meeting/tool-bridge.ts`, which has no AI SDK loop to hook into.
 *
 * They differ only in budget — a meeting's is deliberately smaller, see the
 * bridge — never in shape, because a truncation that behaves differently per
 * channel is a bug report waiting to happen: a payload that reads whole in Slack
 * and arrives beheaded in a call looks like the *data* is missing.
 *
 * Strategy:
 * - Keep the first 80% of the budget (structural headers, column names, initial
 *   results) and the last 20% (end-of-output, summary lines, final entries).
 * - Replace the middle with a notice that says the output is INCOMPLETE. That
 *   wording is the point: a model handed a silently-clipped list reports the
 *   entries it can see as the whole set, so the notice forbids stating a count or
 *   a total and names the way to get the rest (narrower arguments, fewer fields,
 *   the next page).
 */

import type { Tool } from 'ai';
import { logger } from '../logger';

type ToolResultOutput = { type: 'text'; value: string };

const DEFAULT_MAX_CHARS = 30_000;
const HEAD_RATIO = 0.8;

/**
 * Slack above the budget before truncating is worth it: cutting a result to add a
 * ~400-char notice about the 30 chars removed costs the model more than it saves.
 */
const PASSTHROUGH_SLACK = 500;

export interface RenderToolResultOptions {
  /** Character budget for the model-facing text. Defaults to 30,000. */
  maxChars?: number;
  /** Appended to the truncation notice — for channel-specific advice. */
  extraGuidance?: string;
  /** Names the tool in the truncation log line. */
  toolName?: string;
}

/**
 * Render a tool's return value as text for a model, truncated to `maxChars`.
 *
 * Returns the text unchanged when it fits. When it doesn't, logs at warn with the
 * sizes involved — the only record that a model's view of a tool result was
 * narrowed, and the first thing to look at when an agent reports a count that
 * disagrees with reality.
 */
export function renderToolResult(result: unknown, options: RenderToolResultOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const text = stringifyToolOutput(result);
  if (text.length <= maxChars + PASSTHROUGH_SLACK) return text;

  // "content chars" because the returned string is the budget *plus* the notice —
  // anyone comparing this against the message size would otherwise see a mismatch.
  logger.warn(
    `[ToolOutput] ${options.toolName ?? 'tool'} result truncated: kept ${maxChars} content ` +
      `chars of ${text.length}`
  );
  return truncateHeadTail(text, maxChars, options.extraGuidance);
}

/**
 * Wrap each tool with a `toModelOutput` hook that truncates large outputs
 * using the head+tail strategy. The raw output from execute() is preserved
 * for logging — only the model-facing view is truncated.
 *
 * Tools that already define their own `toModelOutput` (e.g. multimodal
 * tools returning image-data) are passed through untouched.
 */
export function withOutputLimits(
  tools: Record<string, Tool>,
  maxChars = DEFAULT_MAX_CHARS
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if ((tool as { toModelOutput?: unknown }).toModelOutput) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      toModelOutput: async ({ output }: { output: unknown }): Promise<ToolResultOutput> => ({
        type: 'text',
        value: renderToolResult(output, { maxChars, toolName: name }),
      }),
    };
  }
  return wrapped;
}

/**
 * Truncate text keeping the head and tail portions.
 * SRE tool outputs typically have column headers/structure at the top
 * and summary/status at the bottom.
 */
export function truncateHeadTail(text: string, maxChars: number, extraGuidance?: string): string {
  const headSize = Math.floor(maxChars * HEAD_RATIO);
  const tailSize = maxChars - headSize;
  const omitted = text.length - headSize - tailSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const extra = extraGuidance ? ` ${extraGuidance}` : '';
  return (
    head +
    `\n\n[INCOMPLETE OUTPUT — ${omitted} chars omitted from the middle; ` +
    `${text.length} chars total. What follows this marker is the END of the output, so ` +
    `whatever was in the omitted middle — further entries, fields, statuses — is not ` +
    `visible to you. Do not state a count, a total, or that this is all of them. To see ` +
    `the rest, call again with narrower arguments: a filter, fewer fields, or the next ` +
    `page.${extra}]\n\n` +
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
  try {
    return JSON.stringify(output);
  } catch {
    // A tool that returned a cyclic or unserializable value must not take the
    // turn down with it — the model can work with the coerced form.
    return String(output);
  }
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
