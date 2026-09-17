/**
 * The accounting seam. What matters is that a row is written for work the
 * caller never sees — every step of a multi-step turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGenerateText, mockGenerateObject, mockRecord } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGenerateObject: vi.fn(),
  mockRecord: vi.fn(),
}));

vi.mock('ai', async () => ({
  ...(await vi.importActual<typeof import('ai')>('ai')),
  generateText: mockGenerateText,
  generateObject: mockGenerateObject,
}));

vi.mock('../services/llm-call.service', () => ({
  llmCallService: { record: mockRecord },
}));

import { NoObjectGeneratedError } from 'ai';
import { inferenceGate } from './inference-gate';
import { callModel, callModelForObject } from './model-call';

const model = { modelId: 'a-model' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('callModel', () => {
  it('records one row per step, and runs the caller’s own onStepFinish after', async () => {
    const seen: string[] = [];
    mockRecord.mockImplementation((row) => seen.push(`record:${row.usage.outputTokens}`));

    mockGenerateText.mockImplementation(async (params: never) => {
      const { onStepFinish } = params as { onStepFinish: (s: unknown) => Promise<void> };
      await onStepFinish({ usage: { inputTokens: 10, outputTokens: 1 } });
      await onStepFinish({ usage: { inputTokens: 20, outputTokens: 2 } });
      return { text: 'done' };
    });

    const callerSteps: unknown[] = [];
    const result = await callModel(
      { purpose: 'chat', threadId: 'thread-1' },
      {
        model,
        prompt: 'hi',
        onStepFinish: (step) => {
          seen.push('caller');
          callerSteps.push(step);
        },
      } as never,
    );

    expect(result).toEqual({ text: 'done' });
    expect(callerSteps).toHaveLength(2);
    // Recorded before the caller sees the step, so a throwing caller cannot
    // lose the row.
    expect(seen).toEqual(['record:1', 'caller', 'record:2', 'caller']);
    expect(mockRecord).toHaveBeenCalledWith({
      purpose: 'chat',
      threadId: 'thread-1',
      model: 'a-model',
      usage: { inputTokens: 10, outputTokens: 1 },
    });
  });

  it('records without a caller onStepFinish', async () => {
    mockGenerateText.mockImplementation(async (params: never) => {
      await (params as { onStepFinish: (s: unknown) => Promise<void> }).onStepFinish({
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      return { text: 'ok' };
    });

    await callModel({ purpose: 'thread-title' }, { model, prompt: 'hi' } as never);

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].purpose).toBe('thread-title');
  });

  it('takes the model id off the model the caller built', async () => {
    mockGenerateText.mockImplementation(async (params: never) => {
      await (params as { onStepFinish: (s: unknown) => Promise<void> }).onStepFinish({ usage: {} });
      return { text: '' };
    });

    await callModel({ purpose: 'compaction' }, { model: 'a-string-id', prompt: 'x' } as never);

    expect(mockRecord.mock.calls[0][0].model).toBe('a-string-id');
  });
});

describe('callModelForObject', () => {
  it('records the call and returns the object', async () => {
    mockGenerateObject.mockResolvedValue({
      object: { action: 'respond' },
      usage: { inputTokens: 30, outputTokens: 3 },
    });

    const result = await callModelForObject(
      { purpose: 'slack-thread-gate' },
      { model, schema: {}, prompt: 'x' } as never,
    );

    expect(result.object).toEqual({ action: 'respond' });
    expect(mockRecord).toHaveBeenCalledWith({
      purpose: 'slack-thread-gate',
      model: 'a-model',
      usage: { inputTokens: 30, outputTokens: 3 },
    });
  });

  it('records nothing when the request never reached a model', async () => {
    mockGenerateObject.mockRejectedValue(new Error('429'));

    await expect(
      callModelForObject({ purpose: 'risk-gate' }, { model, schema: {}, prompt: 'x' } as never),
    ).rejects.toThrow('429');

    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records the tokens a rejected schema still spent', async () => {
    // The model generated text and was billed for it; only the validation
    // failed. Dropping the row undercounts a gate whose JSON is malformed.
    mockGenerateObject.mockRejectedValue(
      new NoObjectGeneratedError({
        message: 'schema rejected',
        text: '{ not json',
        usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
        finishReason: 'stop',
      }),
    );

    await expect(
      callModelForObject(
        { purpose: 'slack-thread-gate' },
        { model, schema: {}, prompt: 'x' } as never,
      ),
    ).rejects.toThrow('schema rejected');

    expect(mockRecord).toHaveBeenCalledWith({
      purpose: 'slack-thread-gate',
      model: 'a-model',
      usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
    });
  });
});

describe('the gate a secure takeover holds', () => {
  afterEach(() => inferenceGate.free());

  it('holds each step of a turn already running, then runs the caller’s own hook', async () => {
    const callerPrepare = vi.fn(() => ({ toolChoice: 'auto' }));
    let ranWhileHeld = true;
    let stepResult: unknown;

    mockGenerateText.mockImplementation(async (params: never) => {
      const { prepareStep } = params as { prepareStep: (o: unknown) => Promise<unknown> };
      // A takeover opens after the turn started: the next step has to wait for it.
      inferenceGate.hold();
      const step = prepareStep({ stepNumber: 1 }).then((result) => (stepResult = result));
      await new Promise((resolve) => setTimeout(resolve, 20));
      ranWhileHeld = callerPrepare.mock.calls.length > 0;

      inferenceGate.free();
      await step;
      return { text: 'done' };
    });

    const result = await callModel(
      { purpose: 'chat' },
      { model, prompt: 'hi', prepareStep: callerPrepare } as never,
    );

    expect(ranWhileHeld).toBe(false);
    expect(callerPrepare).toHaveBeenCalledOnce();
    expect(stepResult).toEqual({ toolChoice: 'auto' });
    expect(result).toEqual({ text: 'done' });
  });
});
