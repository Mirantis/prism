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
import type { ToolOutputTruncation } from '../types';

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
  /**
   * Log the cut at debug rather than warn.
   *
   * Set by the replay path: a legacy row is re-rendered on every context build, so
   * one such row would otherwise warn on every turn — and during compaction — about
   * a cut that happened once, drowning the live warns that mean something.
   */
  quietLog?: boolean;
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
  return renderToolResultDetailed(result, options).text;
}

/** A rendered tool result, plus what the render did to it. */
export interface RenderedToolResult {
  /** The model-facing text. Head + notice + tail when it was cut. */
  text: string;
  /** Present only when the result was cut. */
  truncation?: ToolOutputTruncation;
}

/**
 * `renderToolResult`, plus a structured record of the cut.
 *
 * Callers that persist a result want to know *that* it was cut without parsing the
 * notice back out of the text — the notice is written for the model and its wording
 * is free to change. `renderToolResult` is this function's `.text`.
 */
export function renderToolResultDetailed(
  result: unknown,
  options: RenderToolResultOptions = {}
): RenderedToolResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const text = stringifyToolOutput(result);
  if (text.length <= maxChars + PASSTHROUGH_SLACK) return { text };

  // "content chars" because the returned string is the budget *plus* the notice —
  // anyone comparing this against the message size would otherwise see a mismatch.
  const line =
    `[ToolOutput] ${options.toolName ?? 'tool'} result truncated: kept ${maxChars} content ` +
    `chars of ${text.length}`;
  if (options.quietLog) logger.debug(line);
  else logger.warn(line);
  const priorOmitted = sumPriorOmitted(text);
  return {
    text: cutHeadTail(text, maxChars, options.extraGuidance, priorOmitted),
    truncation: {
      totalChars: priorOmitted + text.length,
      keptChars: maxChars,
      omittedChars: priorOmitted + (text.length - maxChars),
    },
  };
}

/**
 * Render a tool result stored *before* results were persisted as the model-facing
 * view — a row with no `rendered` flag, holding `JSON.stringify(rawOutput)`.
 *
 * The parse mirrors what `parseToolCalls` already does for a tool call's `input`, and
 * it is what makes the replay match what the live turn showed: a stored MCP envelope
 * renders back down to its joined text, and a stored plain string loses the quoting
 * and escaping `JSON.stringify` added. An unparseable value is rendered as-is.
 *
 * Pure in (stored string, budget), so a legacy row's bytes are stable turn to turn —
 * they shift once, at the deploy that introduces this.
 */
export function renderLegacyStoredOutput(
  stored: string,
  options: RenderToolResultOptions = {}
): string {
  return renderToolResult(tryJsonParse(stored) ?? stored, { quietLog: true, ...options });
}

function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Matches a notice this module wrote earlier, capturing how much *that* pass dropped.
 *
 * Cutting an already-cut result is real: a subagent's report is capped inside the
 * subagent's own turn and capped again by the parent, and a meeting's smaller budget
 * re-cuts a result a chat turn already cut. Without this the second notice would
 * report only its own slice, so a payload that lost 470,000 chars upstream would
 * claim to have lost 18,000.
 */
const TRUNCATION_NOTICE_PATTERN =
  /\[INCOMPLETE OUTPUT — (\d+) chars omitted from the middle;/g;

function sumPriorOmitted(text: string): number {
  let total = 0;
  // Built fresh per call. A shared `/g` regex carries `lastIndex`, and `matchAll`
  // copies it into the clone it iterates — so one stray `.test()` anywhere would
  // silently make this miss every notice before that offset.
  const pattern = new RegExp(TRUNCATION_NOTICE_PATTERN.source, 'g');
  for (const match of text.matchAll(pattern)) {
    const omitted = Number(match[1]);
    // The digits come from the text being cut, which a tool controls: `shell_exec`
    // reading a log that happens to contain an old notice, or a hostile payload.
    // An absurd figure must not reach the model or the row — 300 digits parse to
    // Infinity, which serializes to `null` and renders as "cut — 30.0K of null".
    // A count can never exceed what is actually in front of us plus what earlier
    // passes dropped, so anything past the text's own length is not ours.
    if (!Number.isFinite(omitted) || omitted < 0) continue;
    total += omitted;
  }
  return Math.min(total, MAX_ACCUMULATED_OMITTED);
}

/**
 * Ceiling on counts read back out of an earlier notice. Generous — a real chain of
 * cuts over a 10 MiB payload stays far below it — and its only job is to keep a
 * forged figure from producing a nonsense total.
 */
const MAX_ACCUMULATED_OMITTED = 1_000_000_000;

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
  return cutHeadTail(text, maxChars, extraGuidance, 0);
}

/**
 * `truncateHeadTail`, told how much an earlier pass already dropped.
 *
 * The notice has to report the accumulated figure, not this pass's slice: it is the
 * number the model reads, and a second cut that claims only its own 18,000 when
 * 488,000 are actually missing is the confident-wrong-total this notice exists to
 * prevent.
 */
function cutHeadTail(
  text: string,
  maxChars: number,
  extraGuidance: string | undefined,
  priorOmitted: number
): string {
  const headSize = Math.floor(maxChars * HEAD_RATIO);
  const tailSize = maxChars - headSize;
  const omitted = priorOmitted + text.length - headSize - tailSize;
  const total = priorOmitted + text.length;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const extra = extraGuidance ? ` ${extraGuidance}` : '';
  return (
    head +
    `\n\n[INCOMPLETE OUTPUT — ${omitted} chars omitted from the middle; ` +
    `${total} chars total. What follows this marker is the END of the output, so ` +
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
