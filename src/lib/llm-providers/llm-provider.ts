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

import type { LanguageModel, SystemModelMessage, Tool, ToolResultPart } from 'ai';
import { config } from '../../config';

/**
 * A `providerOptions` fragment — vendor namespace → option bag.
 *
 * Declared structurally rather than imported: the SDK's `ProviderOptions` lives
 * in `@ai-sdk/provider-utils`, which `ai` imports but does not re-export and
 * which is not a direct dependency here (same constraint as the member types
 * above). The value union stays inside `JSONValue`, so this is assignable
 * wherever the SDK asks for `providerOptions`.
 */
export type ProviderOptionsFragment = Record<
  string,
  Record<string, string | number | boolean | { [key: string]: string | number | boolean }>
>;

/**
 * Merge `providerOptions` fragments one namespace deep, so two fragments
 * declared for the same vendor namespace combine instead of the later one
 * silently clobbering the earlier.
 */
export function mergeProviderOptions<T extends Record<string, object>>(
  ...fragments: Array<T | undefined>
): T {
  const merged: Record<string, object> = {};
  for (const fragment of fragments) {
    for (const [namespace, options] of Object.entries(fragment ?? {})) {
      merged[namespace] = { ...merged[namespace], ...options };
    }
  }
  return merged as T;
}

/** Whether a tool is sent deferred, in any vendor's `providerOptions`. */
export function isDeferredTool(tool: Tool): boolean {
  return Object.values(tool.providerOptions ?? {}).some(
    (options) => (options as { deferLoading?: unknown } | undefined)?.deferLoading === true,
  );
}

/** One tool that became available, or stopped being available, between two turns. */
export type ToolChange = {
  type: 'tool_addition' | 'tool_removal';
  toolName: string;
};

/**
 * How one model is told that the tools of a conversation changed: the tool
 * stays declared, and a system message in the history names the change.
 */
export interface ToolChangeProtocol {
  /** `providerOptions` for a declared tool that loads only when an addition names it. */
  deferredTool: ProviderOptionsFragment;
  /** The system message that announces `changes`. */
  announce: (changes: ToolChange[]) => SystemModelMessage;
}

/** What one `load_tools` call asks for: exact names, a keyword query, or both. */
export interface ToolLoadRequest {
  names?: string[];
  query?: string;
}

/** What the runtime answered to one `load_tools` call. It is the call's stored result. */
export interface ToolLoad {
  loaded: string[];
  unmatched: string[];
  /** Deferred tool names near the unmatched ones. */
  suggestions: string[];
}

/** A deferred tool's definition, for a vendor whose load result defines the tool. */
export interface DeferredToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The runtime search that a vendor's `load_tools` tool calls. */
export interface ToolLoader {
  description: string;
  load: (request: ToolLoadRequest) => ToolLoad;
  definition: (name: string) => DeferredToolDefinition | undefined;
}

/**
 * How one model loads a tool whose schema the request sends deferred: the
 * provider keeps the tool out of the model's context until a `load_tools`
 * result names it.
 */
export interface DeferredToolProtocol {
  /** `providerOptions` for a tool sent deferred. */
  deferredTool: ProviderOptionsFragment;
  /** The `load_tools` tool on this vendor. */
  loadTool: (loader: ToolLoader) => Tool;
  /**
   * Whether the SDK sends the tools block under tool choice 'none'. A request
   * that replays a load has to declare the tools the load names.
   */
  keepsToolsUnderNone: boolean;
  /**
   * A stored `load_tools` call as a later request sends it. `result.loaded`
   * names only tools that request declares, since a result that names an
   * undeclared tool fails the request.
   */
  replay: (
    call: { id: string; input: unknown; result: ToolLoad },
    loader: ToolLoader,
  ) => { id: string; input: unknown; output: ToolResultPart['output'] };
}

/**
 * Turns extended thinking off on an Anthropic Messages request. Thinking tokens
 * count against the gates' 16-token output cap, and a gate whose cap runs out
 * before the verdict returns empty text.
 */
export const ANTHROPIC_THINKING_OFF: ProviderOptionsFragment = {
  anthropic: { thinking: { type: 'disabled' } },
};

/** Anthropic's ephemeral prompt-cache breakpoint fragment. */
export type AnthropicCachePoint = { anthropic: { cacheControl: { type: 'ephemeral'; ttl?: '1h' } } };

/**
 * How long a request asks its cache entries to stay warm. `1h` costs 2× input on
 * the write instead of 1.25×, so it pays only where people pause between turns.
 */
export type CacheTtl = '5m' | '1h';

/** The cache a run of `mode` asks for: `CHAT_CACHE_TTL` for a chat turn, five minutes for any other. */
export function cacheTtlFor(mode: string): CacheTtl {
  return mode === 'chat' ? config.chatCacheTtl : '5m';
}

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

/** The same breakpoint asking for a one-hour entry. */
export const ANTHROPIC_CACHE_POINT_1H: CachePointFragment = {
  anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
};

/**
 * The Anthropic breakpoint for `ttl`, which every vendor that sends Anthropic's
 * cacheControl declares. The operator who sets `CHAT_CACHE_TTL` checks that the
 * model accepts the lifetime.
 */
export function anthropicCachePoint(ttl?: CacheTtl): CachePointFragment {
  return ttl === '1h' ? ANTHROPIC_CACHE_POINT_1H : ANTHROPIC_CACHE_POINT;
}

/** The fragment Bedrock's Converse surface reads. */
export const BEDROCK_CACHE_POINT: CachePointFragment = {
  bedrock: { cachePoint: { type: 'default' } },
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * How long a cache written through `fragment` stays warm without a read: an hour
 * for a breakpoint that asks for one, else the providers' default of five minutes.
 */
export function cacheTtlMs(fragment: CachePointFragment): number {
  return 'anthropic' in fragment && fragment.anthropic.cacheControl.ttl === '1h' ? ONE_HOUR_MS : FIVE_MINUTES_MS;
}

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
   *
   * `ttl` is the lifetime the breakpoint asks for. A vendor that sends Anthropic's
   * breakpoint sends it as given; one without breakpoints returns the empty
   * fragment, which `cacheTtlMs` reads as five minutes.
   */
  cachePoint: (modelId: string, ttl?: CacheTtl) => CachePointFragment;
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
   * How one model takes a mid-conversation tool change, or undefined when it
   * takes none. A model that does keeps one declared tool list for the life of
   * a conversation, so a change of tools keeps the prompt cache.
   *
   * Keyed on the model, and an allowlist: the SDK sends the change to any
   * model, and a model without support rejects the whole request.
   */
  toolChanges?: (modelId: string) => ToolChangeProtocol | undefined;
  /**
   * How one model loads a deferred tool, or undefined when it loads none, and
   * every tool is then sent whole. An allowlist keyed on the model, since each
   * entry is measured live.
   */
  deferredTools?: (modelId: string) => DeferredToolProtocol | undefined;
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
   * recognizes, which some platforms reject — but a caller like the thread
   * reply classifier has no business knowing which. It asks the active
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
   * tokens would eat the budget before the verdict; Haiku 5.5 can think
   * unasked). The vendor knows what
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
   * default, `{ temperature: 0 }` — deterministic verdicts, which Haiku 4.5
   * accepts. A vendor whose models reject or strip an explicit temperature
   * (Haiku 5.5, GPT-5.x reasoning models; whether the SDK even forwards it
   * depends on its per-model support matrix) declares `{}` so the gates omit
   * the param entirely — the same omit-rather-than-track rule the main
   * invoke path applies to sampling params.
   */
  classificationSamplingParams?: { temperature?: number };
};
