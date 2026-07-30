/**
 * The shape every LLM vendor factory returns.
 *
 * A provider is a callable chat dispatcher — `(modelId) => LanguageModel` —
 * with an `.embedding(modelId)` method attached, so callers of
 * `createProvider()` never have to know which vendor (Bedrock or Azure) or
 * route (direct or Nexus) is in use.
 *
 * Why an explicit named type rather than inference: the vendor SDKs re-export
 * their own nested `@ai-sdk/provider` copies, so an inferred return type can't
 * be named at the import site (TS2742). Annotating both factories with this
 * type keeps the returns portable, and pins Bedrock and Azure to one contract
 * instead of letting them drift apart under inference.
 *
 * The member types come from `ai` (a direct dependency) rather than
 * `@ai-sdk/provider` (only ever hoisted transitively). They are the same types
 * `generateText()` and `embed()`/`embedMany()` accept, which is all any
 * consumer here needs.
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

export type LlmProvider = ((modelId: string) => LanguageModel) & {
  embedding: (modelId: string) => EmbeddingModel;
};
