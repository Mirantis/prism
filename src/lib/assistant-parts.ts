/**
 * One step's assistant content parts, captured as the provider produced them and
 * replayed verbatim.
 *
 * A provider caches a prefix by its exact bytes. The assistant message a step
 * sends is cached at that step's breakpoint, and the next turn reads past it only
 * if the message it sends there is byte-identical. That needs the provider's own
 * parts, ids and reasoning metadata, which is what these store.
 *
 * Capture and replay live in one file because they are one contract — the shape
 * written has to be the shape the SDK accepts back.
 */

import type { ModelMessage, ProviderMetadata } from 'ai';
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
 * a provider-executed tool result, an approval request. Null means the row stores
 * no parts, and replay builds the message from `content` + `toolCalls` instead. A
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
        input: toolCallInput(part),
        ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
      });
      continue;
    }

    return null;
  }

  return parts.length > 0 ? parts : null;
}

/**
 * The arguments to send for a tool call.
 *
 * The provider requires an object. When the model's arguments do not parse the
 * SDK keeps the raw string and marks the call invalid, and sends an empty object
 * in its place — so storing the string would replay a request the provider
 * refuses, on this turn and on every turn after it.
 */
function toolCallInput(part: ContentPartLike): unknown {
  const input = part.input ?? {};
  return typeof input === 'object' && input !== null ? input : {};
}

/**
 * Read a stored `assistantParts` value back.
 *
 * Returns null for anything this cannot replay in full, so a row written by a
 * newer shape, or a hand-edited one, takes the fallback path instead of
 * reaching the provider half-built.
 *
 * A tool name goes through `toModelToolName`, the same function that names the
 * tools block, so a stored name always matches the name the request offers. The
 * function is a fixed point on a name that already came from the tools block, so
 * it changes nothing for a row this runtime wrote; it is what keeps a row
 * written under a different tool set replayable.
 */
export function parseAssistantParts(stored: unknown): StoredAssistantPart[] | null {
  if (!Array.isArray(stored) || stored.length === 0) return null;

  const parts: StoredAssistantPart[] = [];

  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') return null;
    const part = raw as ContentPartLike;
    const providerMeta = (raw as { providerOptions?: ProviderMetadata }).providerOptions;
    const providerOptions = providerMeta ? { providerOptions: providerMeta } : {};

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
        input: toolCallInput(part),
        ...providerOptions,
      });
      continue;
    }

    return null;
  }

  return parts;
}

/**
 * The same messages with every replayed reasoning block removed.
 *
 * A reasoning block's signature is bound to the system prompt, the tools and the
 * messages that came before it. Where a provider checks that binding it refuses
 * the whole request once any of those change, and it names stripping the blocks
 * as the way through. Several ordinary things here move the prefix: the date in
 * the dynamic system message, the agent editing its own soul or memory, an
 * installed plugin changing the tools, a compaction summary replacing history.
 *
 * Text and tool calls stay, so the request keeps its structure and its ids and
 * only the cache read is lost. An assistant message holding nothing but reasoning
 * is dropped: an empty content array is not a message a provider accepts, and
 * such a message carries no tool call for a tool result to answer.
 */
export function withoutReasoning(messages: readonly ModelMessage[]): ModelMessage[] {
  const stripped: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      stripped.push(message);
      continue;
    }
    const kept = message.content.filter((part) => part.type !== 'reasoning');
    if (kept.length === 0) continue;
    stripped.push({ ...message, content: kept } as ModelMessage);
  }

  return stripped;
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
