/**
 * One step's assistant content parts, captured as the provider produced them and
 * replayed verbatim.
 *
 * A provider caches a prefix by its exact bytes. The assistant message a step
 * sends is cached at that step's breakpoint, so the next turn only reads past it
 * if the message it rebuilds from storage is byte-identical. Rebuilding one from
 * `content` + `toolCalls` is not: the provider's reasoning part is missing, and
 * the turn's final text lands on the row holding an earlier step's calls.
 *
 * Capture and replay live in one file because they are one contract — the shape
 * written has to be the shape the SDK accepts back.
 */

import type { ProviderMetadata } from 'ai';
import { toModelToolName } from './tool-names';

/**
 * A part of a stored assistant turn.
 *
 * `providerOptions` is where the provider's own metadata rides — for Anthropic
 * that is a reasoning block's `signature`, which the API requires back unchanged.
 */
export type StoredAssistantPart =
  | { type: 'text'; text: string; providerOptions?: ProviderMetadata }
  | { type: 'reasoning'; text: string; providerOptions?: ProviderMetadata }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerOptions?: ProviderMetadata;
    };

/** What a step's content parts look like to the capture, before any narrowing. */
interface ContentPartLike {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
  providerMetadata?: ProviderMetadata;
}

/**
 * Turn a step's generated content into the assistant parts to store.
 *
 * The skips mirror the SDK's own assistant-message construction: a source part,
 * a tool result the provider did not run itself, and an empty text part never
 * reach the provider, so storing them would make replay differ from the live
 * turn rather than match it.
 *
 * Returns null when the step holds a part this cannot carry — a generated file,
 * a provider-executed tool result, an approval request. Null means "no stored
 * parts for this row", and replay falls back to building the message from
 * `content` + `toolCalls`, which is what every row did before this existed. A
 * partial capture would be worse than none: it would send the provider an
 * assistant turn missing content the model produced.
 */
export function captureAssistantParts(content: readonly unknown[]): StoredAssistantPart[] | null {
  const parts: StoredAssistantPart[] = [];

  for (const raw of content) {
    const part = raw as ContentPartLike;

    if (part.type === 'source') continue;
    if ((part.type === 'tool-result' || part.type === 'tool-error') && !part.providerExecuted) {
      continue;
    }
    if (part.type === 'text' && !part.text) continue;

    if (part.type === 'text' || part.type === 'reasoning') {
      parts.push({
        type: part.type,
        text: part.text ?? '',
        ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
      });
      continue;
    }

    if (part.type === 'tool-call') {
      if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') return null;
      parts.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input ?? {},
        ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
      });
      continue;
    }

    return null;
  }

  return parts.length > 0 ? parts : null;
}

/**
 * Read a stored `assistantParts` value back.
 *
 * Returns null for anything this cannot replay in full, so a row written by a
 * newer shape, or a hand-edited one, takes the fallback path instead of
 * reaching the provider half-built.
 *
 * A tool name goes through `toModelToolName`, the same function that names the
 * tools block: a name stored while it still fit is otherwise re-sent naming a
 * tool the request no longer offers. That is the one place replay may differ
 * from the live bytes, and only for a name the tools block has since shortened —
 * where the alternative is a request the provider rejects.
 */
export function parseAssistantParts(stored: unknown): StoredAssistantPart[] | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;

  const parts: StoredAssistantPart[] = [];

  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') return null;
    const part = raw as ContentPartLike;
    const providerOptions = part.providerMetadata
      ? { providerOptions: part.providerMetadata }
      : (raw as { providerOptions?: ProviderMetadata }).providerOptions
        ? { providerOptions: (raw as { providerOptions?: ProviderMetadata }).providerOptions }
        : {};

    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text !== 'string') return null;
      parts.push({ type: part.type, text: part.text, ...providerOptions });
      continue;
    }

    if (part.type === 'tool-call') {
      if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') return null;
      parts.push({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: toModelToolName(part.toolName),
        input: part.input ?? {},
        ...providerOptions,
      });
      continue;
    }

    return null;
  }

  return parts;
}

/**
 * Drop the reasoning parts from a stored assistant turn.
 *
 * A reasoning block's signature is bound to the history that produced it. Once
 * compaction replaces that history with a summary, the block sits behind a prefix
 * it was never produced against: it buys no cache read, and on a model that checks
 * the binding it is refused outright. The text and the tool calls are unaffected,
 * so the row keeps replaying its structure and its ids.
 *
 * Returns null when nothing but reasoning was stored — the row then replays from
 * `content` + `toolCalls`.
 */
export function stripReasoningParts(
  parts: readonly StoredAssistantPart[]
): StoredAssistantPart[] | null {
  const kept = parts.filter((part) => part.type !== 'reasoning');
  return kept.length > 0 ? kept : null;
}

/** The tool calls in a stored assistant turn, in the order the provider made them. */
export function toolCallsIn(
  parts: readonly StoredAssistantPart[]
): Array<Extract<StoredAssistantPart, { type: 'tool-call' }>> {
  return parts.filter(
    (part): part is Extract<StoredAssistantPart, { type: 'tool-call' }> =>
      part.type === 'tool-call'
  );
}
