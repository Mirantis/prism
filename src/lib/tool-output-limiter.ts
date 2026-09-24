/**
 * Tool Output Limiter
 *
 * The single owner of "render a tool result for a model, and cut it if it is too
 * big". Both paths that hand a tool result to a model use it:
 *
 * - the invoke loop (chat, heartbeat, cron, goals, subagents) via
 *   `withToolOutputCapture`, which wraps each tool's `execute`;
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
import { writeToolOutput, type SpillResult } from './tool-output-store';

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
  priorOmitted: number,
  spill?: SpillResult
): string {
  const headSize = Math.floor(maxChars * HEAD_RATIO);
  const tailSize = maxChars - headSize;
  const omitted = priorOmitted + text.length - headSize - tailSize;
  const total = priorOmitted + text.length;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const extra = extraGuidance ? ` ${extraGuidance}` : '';
  // Search-first, and said in those words. A pointer invites the model to page the
  // whole thing back in, which rebuilds in history exactly the bulk the cut removed
  // — and every page is itself a tool result, stored and replayed.
  const saved = spill
    ? `The full output is saved at ${spill.path}. Read only what you need from it ` +
      `with shell_exec — \`jq\` when it is JSON, otherwise grep or sed. Do not cat the ` +
      `whole file: everything you read comes back into your context, which is what ` +
      `this cut just spared you.` +
      (spill.capped ? ` Only the first ${spill.bytes} bytes were saved.` : '') +
      ' '
    : '';
  return (
    head +
    `\n\n[INCOMPLETE OUTPUT — ${omitted} chars omitted from the middle; ` +
    `${total} chars total. What follows this marker is the END of the output, so ` +
    `whatever was in the omitted middle — further entries, fields, statuses — is not ` +
    `visible to you. Do not state a count, a total, or that this is all of them. ` +
    saved +
    `To see the rest, call again with narrower arguments: a filter, fewer fields, or ` +
    `the next page.${extra}]\n\n` +
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

// ============================================================================
// Saving the omitted middle
// ============================================================================

/**
 * Marks a tool return that was cut. A tool's own return value is whatever the tool
 * says it is, so the wrapper below has to be able to tell "the tool returned an
 * object" from "we replaced the tool's return with a cut of it" — this key is that
 * signal, and nothing else in the codebase uses it.
 */
const SPILL_ENVELOPE = '__prismToolOutputSpill';

export interface SpilledToolOutput {
  readonly [SPILL_ENVELOPE]: true;
  /**
   * The model-facing result: head + notice + tail. Not a sample of the real
   * thing — this *is* what the model reads and what history stores. `raw` is the
   * secondary copy, kept only for consumers that need the tool's own shape.
   */
  text: string;
  truncation: ToolOutputTruncation;
  /** The tool's untouched return, so no structured consumer loses anything. */
  raw: unknown;
  /**
   * What a serializer sees: the cut view and its sizes, without the original.
   *
   * The AI SDK records a tool's return into its telemetry span with
   * `JSON.stringify`, so without this a trace shows this wrapper instead of a
   * result — the reader looks for the truncation notice and finds an object
   * whose keys mean nothing to them — and carries a second full copy of the
   * payload beside the cut one. Every in-process consumer reads `.raw` as a
   * property and is unaffected.
   */
  toJSON(): { text: string; truncation: ToolOutputTruncation };
}

export function isSpilledToolOutput(output: unknown): output is SpilledToolOutput {
  if (typeof output !== 'object' || output === null) return false;
  const candidate = output as Record<string, unknown>;
  // The marker alone is not enough. A tool returns whatever it likes, and a plugin
  // or MCP server that happened to emit this key would otherwise have its result
  // read as an envelope — storing an empty output and handing the model an
  // `undefined` value that fails the SDK's validation and kills the turn with an
  // error traceable to nothing.
  return (
    candidate[SPILL_ENVELOPE] === true &&
    typeof candidate.text === 'string' &&
    typeof candidate.truncation === 'object' &&
    candidate.truncation !== null
  );
}

/** The tool's own return, whether or not it was cut. */
export function unwrapToolOutput(output: unknown): unknown {
  return isSpilledToolOutput(output) ? output.raw : output;
}

export interface ToolOutputCaptureOptions {
  /** Character budget for the model-facing text. Defaults to 30,000. */
  maxChars?: number;
  /** Appended to the notice — for channel-specific advice. */
  extraGuidance?: string;
  /**
   * Save the whole output so it can be read back. Off for a call that only needs
   * the tools block built the same way, and never executes anything.
   */
  spill?: boolean;
  /** The thread's workspace, so the saved copy is where that thread's shell reads. */
  workspaceRoot?: string | null;
}

/**
 * Render a tool result for a model, and save the whole thing when it does not fit.
 *
 * The one place a saved-copy id is minted. It has to be minted here rather than
 * where the result is persisted, because the id has to appear in the text the model
 * reads *and* in the record stored for later — mint it twice and the model is told
 * one id while another is on disk; mint it at replay and every turn writes a new
 * copy and breaks the prompt-cache prefix.
 *
 * A failed save is logged and swallowed. A broken data dir should cost the agent
 * the ability to read the middle back, never the turn.
 */
export async function renderAndSpill(
  result: unknown,
  options: ToolOutputCaptureOptions & { toolName?: string } = {}
): Promise<RenderedToolResult> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const text = stringifyToolOutput(result);
  if (text.length <= maxChars + PASSTHROUGH_SLACK) return { text };

  logger.warn(
    `[ToolOutput] ${options.toolName ?? 'tool'} result truncated: kept ${maxChars} content ` +
      `chars of ${text.length}`
  );

  let spill: SpillResult | undefined;
  if (options.spill !== false) {
    try {
      spill = await writeToolOutput(text, options.workspaceRoot);
    } catch (err) {
      logger.warn(
        { err },
        `[ToolOutput] could not save the full ${options.toolName ?? 'tool'} result; ` +
          'the omitted middle is unrecoverable for this call'
      );
    }
  }

  const priorOmitted = sumPriorOmitted(text);
  const truncation: ToolOutputTruncation = {
    totalChars: priorOmitted + text.length,
    keptChars: maxChars,
    omittedChars: priorOmitted + (text.length - maxChars),
    ...(spill ? { spillId: spill.id } : {}),
  };

  return { text: cutHeadTail(text, maxChars, options.extraGuidance, priorOmitted, spill), truncation };
}

/**
 * Cap every tool's result and save what does not fit.
 *
 * Replaces `withOutputLimits`, which installed only a `toModelOutput` hook and so
 * skipped any tool that already had one — which is *every* MCP tool, since the SDK
 * attaches `mcpToModelOutput` to all of them. The cap therefore never applied to a
 * single Nexus or plugin tool, which is where the oversized payloads actually come
 * from.
 *
 * The cut moves into an `execute` wrapper for two reasons. It reaches every tool,
 * hook or no hook. And `toModelOutput` runs at prompt-conversion time for the
 * *next* step — after the current step has already been recorded — so a saved-copy
 * id minted there could never reach the stored record.
 *
 * A result that fits comes back **by identity**: `extractAttachmentIds` reads
 * `share_file`'s structured return off the step, and `view_attachment` loads bytes
 * out of its own return inside its own hook. Only an oversized result is replaced,
 * and even then the original travels along in the envelope.
 */
export function withToolOutputCapture(
  tools: Record<string, Tool>,
  options: ToolOutputCaptureOptions = {}
): Record<string, Tool> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const wrapped: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const original = tool as Tool & {
      execute?: (...args: unknown[]) => unknown;
      toModelOutput?: (opts: { output: unknown }) => unknown;
    };
    const ownToModelOutput = original.toModelOutput?.bind(original);

    wrapped[name] = {
      ...original,
      ...(original.execute
        ? {
            execute: async (...args: unknown[]) => {
              const raw = await original.execute!(...args);
              const rendered = await renderAndSpill(raw, {
                ...options,
                maxChars,
                toolName: name,
              });
              if (!rendered.truncation) return raw;
              const truncation = rendered.truncation;
              return {
                [SPILL_ENVELOPE]: true,
                text: rendered.text,
                truncation,
                raw,
                toJSON: () => ({ text: rendered.text, truncation }),
              } satisfies SpilledToolOutput;
            },
          }
        : {}),
      toModelOutput: ownToModelOutput
        ? async (opts: { output: unknown }) => {
            // The tool's own hook must see exactly what it would have seen — an
            // image tool loads bytes out of its return here, and a truncated
            // envelope would be meaningless to it.
            const inner = (await ownToModelOutput({
              ...opts,
              output: unwrapToolOutput(opts.output),
            })) as ToolModelOutput;
            return capModelOutput(
              inner,
              isSpilledToolOutput(opts.output) ? opts.output.text : null
            );
          }
        : async ({ output }: { output: unknown }): Promise<ToolResultOutput> => ({
            type: 'text',
            value: isSpilledToolOutput(output)
              ? output.text
              : renderToolResult(output, { maxChars, toolName: name }),
          }),
    } as Tool;
  }

  return wrapped;
}

/** Any shape a tool's own `toModelOutput` may return. */
type ToolModelOutput =
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'json' | 'error-json'; value: unknown }
  | { type: 'content'; value: Array<{ type: string; text?: string; [k: string]: unknown }> };

/**
 * Put the cut view into whatever shape a tool's own hook returned.
 *
 * `cutText` is null when nothing was cut, and then the hook's output is passed
 * through untouched — the common case, and the one that keeps images and structured
 * returns working exactly as before.
 *
 * Non-text parts are never cut. Slicing base64 in half produces a corrupt image
 * rather than a smaller one, and image size is already bounded where images are
 * made.
 */
export function capModelOutput(inner: ToolModelOutput, cutText: string | null): ToolModelOutput {
  if (cutText === null) return inner;

  switch (inner.type) {
    case 'text':
    case 'json':
      return { type: 'text', value: cutText };
    case 'error-text':
    case 'error-json':
      return { type: 'error-text', value: cutText };
    case 'content': {
      const nonText = inner.value.filter((part) => part.type !== 'text');
      return { type: 'content', value: [{ type: 'text', text: cutText }, ...nonText] };
    }
    default:
      return inner;
  }
}
