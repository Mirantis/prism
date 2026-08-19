/**
 * The shape every LLM vendor factory returns.
 *
 * A provider is a callable chat dispatcher — `(modelId) => LanguageModel` —
 * with an `.embedding(modelId)` method attached, so callers of
 * `createProvider()` never have to know which vendor (Bedrock, Azure,
 * bedrock-mantle or OpenAI) or route (direct or gateway) is in use.
 *
 * Why an explicit named type rather than inference: the vendor SDKs re-export
 * their own nested `@ai-sdk/provider` copies, so an inferred return type can't
 * be named at the import site (TS2742). Annotating every factory with this
 * type keeps the returns portable, and pins the vendors to one contract
 * instead of letting them drift apart under inference.
 *
 * The member types come from `ai` (a direct dependency) rather than
 * `@ai-sdk/provider` (only ever hoisted transitively). They are the same types
 * `generateText()` and `embed()`/`embedMany()` accept, which is all any
 * consumer here needs.
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * A `providerOptions` fragment — vendor namespace → option bag.
 *
 * Declared structurally rather than imported: the SDK's `ProviderOptions` lives
 * in `@ai-sdk/provider-utils`, which `ai` imports but does not re-export and
 * which is not a direct dependency here (same constraint as the member types
 * above). The value union stays inside `JSONValue`, so this is assignable
 * wherever the SDK asks for `providerOptions`.
 */
export type ProviderOptionsFragment = Record<string, Record<string, string | number | boolean>>;

/** Anthropic's ephemeral prompt-cache breakpoint fragment. */
export type AnthropicCachePoint = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/**
 * A `providerOptions` fragment that marks a prompt-cache breakpoint on
 * whatever element carries it (a system message, a chat message, the last
 * tool). The Claude-serving vendors declare Anthropic's ephemeral
 * cacheControl — the point of routing it through the provider is that
 * callers never hardcode a vendor namespace. A vendor whose prompt caching
 * is automatic (OpenAI) declares the empty fragment instead: spreading it
 * into `providerOptions` is a harmless no-op on the wire.
 */
export type CachePointFragment = AnthropicCachePoint | Record<string, never>;

/** The fragment the Claude-serving vendors declare as their `cachePoint`. */
export const ANTHROPIC_CACHE_POINT: CachePointFragment = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/** The fragment for vendors whose prompt caching needs no breakpoints. */
export const NO_CACHE_POINT: CachePointFragment = {};

export type LlmProvider = ((modelId: string) => LanguageModel) & {
  embedding: (modelId: string) => EmbeddingModel;
  /** The vendor's prompt-cache breakpoint fragment; see CachePointFragment. */
  cachePoint: CachePointFragment;
  /**
   * `providerOptions` to merge into structured-output (`generateObject`) calls
   * on this vendor, or undefined when the SDK's default path already works.
   *
   * This exists so vendor quirks stay behind the seam. Left to itself the SDK
   * sends Anthropic's native `output_config.format` for any model id it
   * recognizes, which some platforms reject — but a caller like the Slack
   * thread classifier has no business knowing which. It asks the active
   * provider what to send and forwards it.
   */
  structuredOutputOptions?: ProviderOptionsFragment;
  /**
   * `providerOptions` to merge into every classification/gate call on this
   * vendor, or undefined when the model's defaults already suit them.
   *
   * The gates run a small model with `temperature: 0` and tiny output-token
   * budgets — assumptions a reasoning model breaks (GPT-5.x rejects
   * non-default temperature outside `reasoningEffort: 'none'`, and reasoning
   * tokens would eat the budget before the verdict). The vendor knows what
   * its classification model needs; the gate call sites don't.
   */
  classificationProviderOptions?: ProviderOptionsFragment;
  /**
   * Smallest `maxOutputTokens` a classification/gate call may send on this
   * vendor; undefined when any positive cap is legal. The OpenAI Responses
   * API rejects caps below 16 outright, and a gate whose every call errors
   * is a gate disabled (fail-open or fail-closed, per site). Carried through
   * `getGateRequest()` so a latency-tuned site can keep a tighter cap on the
   * vendors that allow one.
   */
  classificationMinOutputTokens?: number;
  /**
   * Sampling params for classification/gate calls. Undefined means the
   * default, `{ temperature: 0 }` — deterministic verdicts, which the Claude
   * models accept. A vendor whose models reject or strip an explicit
   * temperature (GPT-5.x reasoning models; whether the SDK even forwards it
   * depends on its per-model support matrix) declares `{}` so the gates omit
   * the param entirely — the same omit-rather-than-track rule the main
   * invoke path applies to sampling params.
   */
  classificationSamplingParams?: { temperature?: number };
};
