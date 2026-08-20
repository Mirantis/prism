/**
 * Tool Names
 *
 * The single owner of "what a tool may be called when it reaches a model".
 *
 * Every provider constrains the name of a tool it is offered, and the binding
 * constraint is a length one: exceed it and the *whole request* is rejected.
 * Names an MCP server advertises are not ours to choose, and one arriving
 * pre-namespaced with a 36-character UUID is enough to blow the budget.
 *
 * Two callers, and they must agree byte for byte:
 *
 * - `lib/tool-collection.ts` caps the assembled tool set — the last point
 *   before a request, so it covers built-ins, Nexus MCP, plugin MCP, the Task
 *   tool, and the voice-meeting bridge that re-declares the same keys;
 * - `prompts/context-builder.ts` runs stored names from history through the
 *   same function, so history matches the tools block on replay.
 *
 * That agreement is why `toModelToolName` is a pure, deterministic function of
 * the name alone, and idempotent, which is what makes running it on both sides
 * safe.
 *
 * An MCP tool's `execute` closes over the name the *server* gave it
 * (`@ai-sdk/mcp` builds it that way), so the record key is only ever what we
 * show the model: renaming the key leaves the call to the server untouched.
 */

import { createHash } from 'crypto';
import type { Tool } from 'ai';
import { logger } from '../logger';

/**
 * Bedrock Converse caps `toolSpec.name` at 64 characters. Anthropic's Messages
 * API allows 128 and the OpenAI Responses API 64, so 64 is the binding
 * constraint — and Bedrock is this runtime's default provider.
 */
export const MAX_TOOL_NAME = 64;

/** How many characters of digest a shortened name carries. */
const DIGEST_LENGTH = 7;

/**
 * One `__`-separated part of a name, reduced to the character set every
 * provider accepts.
 */
export function sanitizeToolNameSegment(segment: string): string {
  const cleaned = segment
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    // Collapse runs so `__` stays unambiguous as the joiner.
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  // A segment of pure punctuation cleans down to nothing — a plugin directory
  // literally named "___" or "...", say, since directory names are not held to
  // the spec's manifest-name pattern. Dropping it would take the whole
  // namespace with it, so two such plugins would collide on one tool name and
  // one would be silently discarded. A digest keeps every segment contributing
  // exactly one stable token.
  return cleaned || `x${createHash('sha256').update(segment).digest('hex').slice(0, 6)}`;
}

/**
 * The name a model may be shown for a tool, given whatever it is called at
 * source.
 *
 * Sanitized per `__`-separated segment, guarded against a leading digit, and
 * capped. An over-long name is truncated and suffixed with a digest of the full
 * name, so two long names that share a prefix stay distinct and each one is
 * stable across restarts — the tools block must keep its shape between
 * processes or the prompt cache misses on every boot.
 *
 * Splitting on the joiner first is load-bearing: `sanitizeToolNameSegment`
 * collapses runs of underscores, so running it over an already-joined name
 * would eat the `__` joiners and merge the namespace into the tool's own name.
 */
export function toModelToolName(name: string): string {
  const base = name.split('__').map(sanitizeToolNameSegment).join('__');
  // A name starting with a digit reads as an array index, and JavaScript
  // enumerates integer-like keys first regardless of insertion order — which
  // would silently break the ordering the cache depends on.
  const safe = /^[A-Za-z_]/.test(base) ? base : `t_${base}`;
  if (safe.length <= MAX_TOOL_NAME) return safe;
  const digest = createHash('sha256').update(safe).digest('hex').slice(0, DIGEST_LENGTH);
  return `${safe.slice(0, MAX_TOOL_NAME - DIGEST_LENGTH - 1).replace(/_+$/, '')}_${digest}`;
}

/**
 * Rename anything in an assembled tool set that a provider would reject.
 *
 * Insertion order is preserved, because it is part of the prompt-cache prefix:
 * `withToolsCacheControl` marks the *last* key, and the tools block goes out in
 * this order.
 *
 * `reserved` holds the names the caller's own tools own. A rename that lands on
 * one is dropped rather than allowed through, because a remote tool answering to
 * a first-party name is worse than losing it — and arrival order cannot be
 * relied on to prevent it: `Task` is added after the MCP maps merge, and an
 * integer-like remote key enumerates ahead of everything regardless of when it
 * was inserted. A name the *mode* withheld belongs in the set too; its slot is
 * empty, not free. A collision between two renamed tools keeps the first.
 */
export function capToolNames(
  tools: Record<string, Tool>,
  source: string,
  reserved: ReadonlySet<string> = new Set(),
): Record<string, Tool> {
  const result: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const capped = toModelToolName(name);
    if (capped !== name) {
      if (reserved.has(capped)) {
        logger.warn(
          '[Tools] %s: dropping tool "%s" — its model-facing name "%s" belongs to a built-in',
          source,
          name,
          capped,
        );
        continue;
      }
      logger.debug('[Tools] %s: "%s" is offered to the model as "%s"', source, name, capped);
    }
    if (capped in result) {
      logger.warn(
        '[Tools] %s: dropping tool "%s" — its model-facing name "%s" is already taken',
        source,
        name,
        capped,
      );
      continue;
    }
    result[capped] = tool;
  }

  return result;
}
