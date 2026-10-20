/**
 * Model Routing Tests
 *
 * Which tier a turn runs on: the classifier's label, failing up, and the hold
 * rule that keeps a thread on its model while that model's cache is warm.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallModel, mockPrisma, mockWindow, mockSentId } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSentId: vi.fn((id: string) => id),
  mockPrisma: {
    llmCall: { findFirst: vi.fn() },
    conversationThread: { findUnique: vi.fn() },
  },
  mockWindow: vi.fn(),
}));

vi.mock('./model-call', () => ({ callModel: mockCallModel }));
vi.mock('./classification', () => ({
  getGateRequest: () => ({ model: 'classifier', providerOptions: {}, samplingParams: {} }),
}));
vi.mock('./prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock('./context-window', () => ({ contextWindowFor: mockWindow }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { selectTurnModel, compactionModel, PROMPT_CACHE_TTL_MS } from './model-routing';
import { config } from '../config';
import { createTestAgentContext, createTestInvokeRequest } from '../test-utils/factories';
import type { AgentContext } from '../types';
import type { LlmProvider } from './llm-providers/llm-provider';

const provider = ((id: string) => ({ modelId: mockSentId(id) })) as unknown as LlmProvider;

const TIERS = { small: 'small-model', medium: 'medium-model', large: 'large-model' };

function autoContext(tiers: Partial<typeof TIERS> = TIERS): AgentContext {
  return createTestAgentContext({
    modelSelection: {
      mode: 'auto',
      tiers: { small: null, medium: null, large: null, ...tiers },
    },
  });
}

function label(word: string) {
  mockCallModel.mockResolvedValueOnce({ text: word });
}

/** The thread's newest turn ran on `model`, `agoMs` ago. */
function lastTurn(model: string, agoMs: number, purpose = 'chat') {
  mockPrisma.llmCall.findFirst.mockResolvedValue({
    purpose,
    model,
    createdAt: new Date(Date.now() - agoMs),
  });
}

const request = createTestInvokeRequest({ mode: 'chat', prompt: 'hi', threadId: 'thread-1' });

beforeEach(() => {
  vi.clearAllMocks();
  config.agentId = 'agent-1';
  mockPrisma.llmCall.findFirst.mockResolvedValue(null);
  mockPrisma.conversationThread.findUnique.mockResolvedValue(null);
  mockWindow.mockReturnValue(null);
  mockSentId.mockImplementation((id: string) => id);
});

describe('selectTurnModel', () => {
  it('runs the fixed model in Fixed mode without a classifier call', async () => {
    const context = createTestAgentContext({ model: 'pinned-model' });

    const result = await selectTurnModel(context, request, provider);

    expect(result).toEqual({ modelId: 'pinned-model', tier: null, reason: 'fixed' });
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it('keeps the heartbeat override in Fixed mode', async () => {
    const context = createTestAgentContext({ model: 'main', heartbeatModel: 'hb' });

    const result = await selectTurnModel(context, { ...request, mode: 'heartbeat' }, provider);

    expect(result.modelId).toBe('hb');
  });

  it('runs the tier the classifier names', async () => {
    label('SMALL');

    const result = await selectTurnModel(autoContext(), request, provider);

    expect(result).toEqual({ modelId: 'small-model', tier: 'small', reason: 'classified' });
    expect(mockCallModel).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'model-routing', threadId: 'thread-1' }),
      expect.anything(),
    );
  });

  it('fails up to the large tier when the classifier errors', async () => {
    mockCallModel.mockRejectedValueOnce(new Error('throttled'));

    const result = await selectTurnModel(autoContext(), request, provider);

    expect(result).toEqual({ modelId: 'large-model', tier: 'large', reason: 'fallback' });
  });

  it('fails up when the answer is not a tier on offer', async () => {
    label('MEDIUM');

    const result = await selectTurnModel(autoContext({ small: 'small-model', large: 'large-model' }), request, provider);

    expect(result).toEqual({ modelId: 'large-model', tier: 'large', reason: 'fallback' });
  });

  it('offers only small and large when medium is unset', async () => {
    label('SMALL');

    await selectTurnModel(autoContext({ small: 'small-model', large: 'large-model' }), request, provider);

    const system = mockCallModel.mock.calls[0][1].system as string;
    expect(system).toContain('Answer with exactly one word: SMALL, LARGE.');
    expect(system).not.toContain('MEDIUM');
  });

  it('runs the fixed model when Auto lacks a required tier', async () => {
    const context = autoContext({ small: 'small-model' });
    context.model = 'pinned-model';

    const result = await selectTurnModel(context, request, provider);

    expect(result).toEqual({ modelId: 'pinned-model', tier: null, reason: 'fixed' });
  });

  it('classifies the heartbeat checks rather than the fixed heartbeat prompt', async () => {
    label('SMALL');
    const context = autoContext();
    context.heartbeatMd = 'Check the deploy pipeline for failures.';

    await selectTurnModel(context, { ...request, mode: 'heartbeat', prompt: 'Perform your heartbeat check now.' }, provider);

    const input = mockCallModel.mock.calls[0][1].messages[0].content as string;
    expect(input).toContain('Check the deploy pipeline for failures.');
    expect(input).not.toContain('Perform your heartbeat check now.');
  });

  it('shows the classifier the previous reply, cut short', async () => {
    label('LARGE');
    const context = autoContext();
    context.recentMessages = [
      { id: 'a', role: 'AGENT', content: `Here is the migration plan. ${'x'.repeat(2000)}` },
      { id: 'u', role: 'USER', content: 'yes, do it' },
    ];

    await selectTurnModel(context, { ...request, prompt: 'yes, do it' }, provider);

    const input = mockCallModel.mock.calls[0][1].messages[0].content as string;
    expect(input).toContain('Here is the migration plan.');
    expect(input.length).toBeLessThan(800);
  });

  describe('hold rule', () => {
    it('moves up while the cache is warm', async () => {
      lastTurn('small-model', 60_000);
      label('LARGE');

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result).toEqual({ modelId: 'large-model', tier: 'large', reason: 'classified' });
    });

    it('holds a warm thread on its tier instead of moving down', async () => {
      lastTurn('medium-model', 60_000);
      label('SMALL');

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result).toEqual({ modelId: 'medium-model', tier: 'medium', reason: 'held' });
    });

    it('moves down once the cache has gone cold', async () => {
      lastTurn('large-model', PROMPT_CACHE_TTL_MS + 1000);
      label('SMALL');

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result.tier).toBe('small');
    });

    it('moves down on the first turn after compaction', async () => {
      lastTurn('large-model', 1000, 'compaction');
      label('SMALL');

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result.tier).toBe('small');
    });

    it('skips the classifier while a warm thread holds the largest tier', async () => {
      lastTurn('large-model', 60_000);

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result).toEqual({ modelId: 'large-model', tier: 'large', reason: 'held' });
      expect(mockCallModel).not.toHaveBeenCalled();
    });

    it('holds nothing when the last turn ran on a model outside the tiers', async () => {
      lastTurn('pinned-model', 60_000);
      label('SMALL');

      const result = await selectTurnModel(autoContext(), request, provider);

      expect(result.tier).toBe('small');
    });

    it('matches the id the provider sent when it rewrites the configured one', async () => {
      mockSentId.mockImplementation((id: string) => id.replace(/^global\./, ''));
      lastTurn('medium-model', 60_000);
      label('SMALL');

      const context = autoContext({ small: 'global.small-model', medium: 'global.medium-model', large: 'global.large-model' });
      const result = await selectTurnModel(context, request, provider);

      expect(result).toEqual({ modelId: 'global.medium-model', tier: 'medium', reason: 'held' });
    });

    it('reads only the thread\'s turns and compactions', async () => {
      label('SMALL');

      await selectTurnModel(autoContext(), request, provider);

      const where = mockPrisma.llmCall.findFirst.mock.calls[0][0].where;
      expect(where.threadId).toBe('thread-1');
      expect(where.purpose.in).not.toContain('model-routing');
      expect(where.purpose.in).toContain('compaction');
    });
  });

  it('leaves out a tier whose window cannot hold the thread', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({ contextTokens: 250_000 });
    mockWindow.mockImplementation((id: string) => (id === 'small-model' ? { tokens: 200_000 } : { tokens: 1_000_000 }));
    label('MEDIUM');

    await selectTurnModel(autoContext(), request, provider);

    const system = mockCallModel.mock.calls[0][1].system as string;
    expect(system).toContain('Answer with exactly one word: MEDIUM, LARGE.');
  });
});

describe('compactionModel', () => {
  it('uses the fixed model in Fixed mode', async () => {
    const context = createTestAgentContext({ model: 'pinned-model' });

    expect(await compactionModel(context, 'thread-1', provider)).toBe('pinned-model');
  });

  it('uses the model the thread last ran on in Auto mode', async () => {
    lastTurn('medium-model', 60_000);

    expect(await compactionModel(autoContext(), 'thread-1', provider)).toBe('medium-model');
  });

  it('uses the large tier when no turn ran on a tier', async () => {
    expect(await compactionModel(autoContext(), 'thread-1', provider)).toBe('large-model');
  });
});
