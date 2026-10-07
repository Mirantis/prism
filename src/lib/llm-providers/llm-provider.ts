/**
 * The shape every LLM vendor factory returns.
 *
 * A provider is a callable chat dispatcher — `(modelId) => LanguageModel` —
 * plus the per-vendor declarations below, so callers of `createProvider()`
 * never have to know which vendor or route (direct or gateway) is in use.
 *
 * Why an explicit named type rather than inference: the vendor SDKs re-export
 * their own nested `@ai-sdk/provider` copies, so an inferred return type can't
 * be named at the import site (TS2742). Annotating every factory with this
 * type keeps the returns portable, and pins the vendors to one contract
 * instead of letting them drift apart under inference.
 *
 * The member types come from `ai` (a direct dependency) rather than
 * `@ai-sdk/provider` (only ever hoisted transitively). They are the same types
 * `generateText()` accepts, which is all any consumer here needs.
 */

import type { LanguageModel } from 'ai';

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
 * Bedrock Converse's own breakpoint — a `cachePoint` block in the request,
 * which is a different wire form and a different `providerOptions` namespace
 * than Anthropic's `cache_control`. `@ai-sdk/amazon-bedrock` reads it from
 * `bedrock` (or `amazonBedrock`) and drops any other namespace without an
 * error, so a fragment aimed at the wrong one costs a silent cache miss on
 * every request rather than a failure anyone would notice.
 */
export type BedrockCachePoint = { bedrock: { cachePoint: { type: 'default' } } };

/**
 * A `providerOptions` fragment that marks a prompt-cache breakpoint on
 * whatever element carries it (a system message, a chat message, the last
 * tool). The Claude-serving vendors declare Anthropic's ephemeral
 * cacheControl — the point of routing it through the provider is that
 * callers never hardcode a vendor namespace. A vendor whose prompt caching
 * is automatic (OpenAI) declares the empty fragment instead: spreading it
 * into `providerOptions` is a harmless no-op on the wire.
 */
export type CachePointFragment =
  | AnthropicCachePoint
  | BedrockCachePoint
  | Record<string, never>;

/** The fragment the Claude-serving vendors declare as their `cachePoint`. */
export const ANTHROPIC_CACHE_POINT: CachePointFragment = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/** The fragment Bedrock's Converse surface reads. */
export const BEDROCK_CACHE_POINT: CachePointFragment = {
  bedrock: { cachePoint: { type: 'default' } },
};

/**
 * The fragment for vendors whose prompt caching needs no breakpoints — and for
 * the ones whose support for them is unknown. Both mean "send nothing", which
 * spreads into `providerOptions` as a no-op.
 */
export const NO_CACHE_POINT: CachePointFragment = {};

export type LlmProvider = ((modelId: string) => LanguageModel) & {
  /**
   * The prompt-cache breakpoint fragment for one model; see
   * CachePointFragment.
   *
   * Keyed on the model rather than fixed per provider because a single vendor
   * can serve two protocols: Bedrock routes Claude through the Anthropic
   * Messages API and everything else through Converse, and the two read their
   * breakpoints from different namespaces. Getting it wrong is invisible —
   * the SDK drops an unrecognized namespace silently — so the choice belongs
   * beside the dispatcher that picks the protocol, not at the call site.
   */
  cachePoint: (modelId: string) => CachePointFragment;
  /**
   * Whether one model gets a prompt-cache breakpoint on this vendor, for the
   * startup line to report; undefined when the vendor has nothing to say and
   * the line omits the field.
   *
   * Only a vendor whose answer varies by model declares it, which today is
   * Bedrock alone: it serves Claude over the Anthropic Messages API and
   * everything else over Converse, so the same deployment caches or does not
   * depending on `BEDROCK_MODEL_ID`. A vendor with one answer for every model
   * it serves reports nothing, because `cachePoint` alone cannot say which
   * answer that is — the empty fragment covers both "caching is automatic
   * here" (OpenAI) and "this model takes no breakpoint".
   */
  promptCacheState?: (modelId: string) => 'on' | 'off';
  /**
   * A check the vendor runs once at startup, logging what the operator has to
   * fix; undefined when the vendor has nothing to verify. It never rejects.
   *
   * LiteLLM declares it: its model ids are the operator's own aliases, so only
   * the proxy's model list can confirm that the configured ones exist.
   */
  startupCheck?: () => Promise<void>;
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
