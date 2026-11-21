/**
 * The one way this runtime calls a model. Every call goes through `callModel`
 * or `callModelForObject`, which record what it cost in `llm_calls` before
 * handing the result back, so accounting is a property of the seam rather than
 * something each call site has to remember.
 */

import {
  generateObject,
  generateText,
  NoObjectGeneratedError,
  type FlexibleSchema,
  type InferSchema,
  type LanguageModel,
} from 'ai';
import { inferenceGate } from './inference-gate';
import { llmCallService, type LlmCallPurpose } from '../services/llm-call.service';
import type { SpendSource } from './spend-context';

export interface ModelCallMeta {
  purpose: LlmCallPurpose;
  /** The thread this call belongs to, where it has one. */
  threadId?: string;
  /** The request this call served, where the spend context names another. */
  requestId?: string;
  /** What started that request, where the spend context names another. */
  source?: SpendSource;
  /** The subagent the call ran for, where it was not the owner's own work. */
  agentId?: string;
}

/** The id the provider will send, taken from the model the caller built. */
function modelIdOf(model: LanguageModel): string {
  return typeof model === 'string' ? model : (model?.modelId ?? 'unknown');
}

type TextParams = Parameters<typeof generateText>[0];
type TextResult = Awaited<ReturnType<typeof generateText>>;

/**
 * `generateText`, with one `llm_calls` row per completed step.
 *
 * Recording rides `onStepFinish` so a multi-step turn is counted step by step,
 * as the provider bills it, and a turn that dies part-way keeps the steps it
 * finished. A caller's own `onStepFinish` runs after the row is written.
 *
 * The gate a secure takeover of the computer holds is asked before every step, not
 * only before the call: one `generateText` runs a whole tool loop, so a takeover that
 * opens mid-turn has to stop the next step rather than the next turn. A password is
 * then typed with nothing running that could decide to look at it.
 */
export async function callModel(meta: ModelCallMeta, params: TextParams): Promise<TextResult> {
  await inferenceGate.wait(params.abortSignal);
  const model = modelIdOf(params.model);
  const callerOnStepFinish = params.onStepFinish;
  const callerPrepareStep = params.prepareStep;

  return generateText({
    ...params,
    prepareStep: async (options) => {
      await inferenceGate.wait(params.abortSignal);
      const prepared = await callerPrepareStep?.(options);
      // The caller's own hook awaits work of its own — the steering drain reads the
      // database — so a window that opened while it ran is still ahead of this step.
      await inferenceGate.wait(params.abortSignal);
      return prepared;
    },
    onStepFinish: async (step) => {
      llmCallService.record({ ...meta, model, usage: step.usage });
      await callerOnStepFinish?.(step);
    },
  });
}

/**
 * `generateObject`, with one `llm_calls` row for the call.
 *
 * Structured output is a single request, so there is one row. A schema the model
 * failed to satisfy still spends the tokens it generated, and the SDK hands them
 * back on the error, so that row is written too.
 */
export async function callModelForObject<
  SCHEMA extends FlexibleSchema<unknown>,
  OUTPUT extends 'object' | 'array' | 'enum' | 'no-schema' = InferSchema<SCHEMA> extends string
    ? 'enum'
    : 'object',
  RESULT = OUTPUT extends 'array' ? Array<InferSchema<SCHEMA>> : InferSchema<SCHEMA>,
>(
  meta: ModelCallMeta,
  params: Parameters<typeof generateObject<SCHEMA, OUTPUT, RESULT>>[0],
): Promise<Awaited<ReturnType<typeof generateObject<SCHEMA, OUTPUT, RESULT>>>> {
  await inferenceGate.wait(params.abortSignal);
  const model = modelIdOf(params.model);

  try {
    const result = await generateObject<SCHEMA, OUTPUT, RESULT>(params);
    llmCallService.record({ ...meta, model, usage: result.usage });
    return result;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      llmCallService.record({ ...meta, model, usage: error.usage });
    }
    throw error;
  }
}
