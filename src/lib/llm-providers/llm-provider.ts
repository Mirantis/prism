/**
 * The shape every LLM vendor factory returns.
 *
 * A provider is a callable chat dispatcher — `(modelId) => LanguageModel` —
 * with an `.embedding(modelId)` method attached, so callers of
 * `createProvider()` never have to know which vendor (Bedrock, Azure or
 * bedrock-mantle) or route (direct or Nexus) is in use.
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

export type LlmProvider = ((modelId: string) => LanguageModel) & {
  embedding: (modelId: string) => EmbeddingModel;
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
};
