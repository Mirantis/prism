/**
 * The OpenAI-shaped provider both `openai` and `openrouter` are built from.
 *
 * Two vendors reach `@ai-sdk/openai`: the official API, and OpenRouter, whose
 * own API is OpenAI-compatible. What differs between them — the endpoint, the
 * credential, the model-id convention, the startup log line — stays in their
 * own factories; everything here is a property of the *SDK surface*:
 * `createOpenAI()(modelId)` dispatches to the Responses API, embeddings ride
 * the same client, prompt caching is automatic (no breakpoints), and the
 * Responses API's own limits shape what a gate call may send.
 *
 * Shared rather than duplicated because those last four are a matched set: a
 * copy that drifts on one of them fails at the gate, not at startup — every
 * classification call 400s and the gate is silently disabled. One definition
 * keeps the two vendors from diverging by accident, and each keeps its own
 * factory so it can diverge on purpose.
 *
 * Classification caveat (why the three gate knobs exist): elsewhere the gates
 * run the classification model with `temperature: 0` and tiny output-token
 * budgets — assumptions GPT-5.x breaks three ways. `reasoningEffort: 'none'`
 * (reasoning tokens would eat the budget before the verdict), a 16-token
 * output floor (the Responses API rejects any `max_output_tokens` below 16,
 * and a gate whose every call 400s is a gate disabled), and empty sampling
 * params — GPT-5.x models reject an explicit temperature outside effort
 * 'none', and whether the SDK even forwards it there depends on its per-model
 * support matrix (< 3.0.91 strips it for gpt-5.6 with a warning). Omitting the
 * param beats tracking any of that, which is the same rule the main invoke
 * path applies: it sends no sampling params at all and runs the chat model at
 * its default reasoning effort.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { NO_CACHE_POINT, type LlmProvider } from './llm-provider';

export interface OpenAiCompatibleOptions {
  /** Key sent as the bearer header; undefined leaves the SDK's env fallback. */
  apiKey?: string;
  /** Endpoint ending at `/v1`; undefined → the SDK default, api.openai.com. */
  baseURL?: string;
}

export function createOpenAiCompatibleProvider({
  apiKey,
  baseURL,
}: OpenAiCompatibleOptions): LlmProvider {
  const openai = createOpenAI({ apiKey, baseURL });

  const dispatcher = (modelId: string) => openai(modelId);
  return Object.assign(dispatcher, {
    // Same client, same mount: the OpenAI surface has no split for embeddings.
    embedding: (modelId: string) => openai.embedding(modelId),
    cachePoint: NO_CACHE_POINT,
    // See the classification caveat in the header: reasoning off, or the
    // gates' tiny token budgets are spent on reasoning instead of the
    // verdict.
    classificationProviderOptions: { openai: { reasoningEffort: 'none' } },
    // The Responses API rejects max_output_tokens < 16.
    classificationMinOutputTokens: 16,
    // No explicit temperature: GPT-5.x rejects or strips it (see header).
    classificationSamplingParams: {},
  });
}
