import { describe, expect, it, beforeEach, vi } from 'vitest';

const { mockSetThreadContextUsage } = vi.hoisted(() => ({
  mockSetThreadContextUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./conversation.service', () => ({
  conversationService: { setThreadContextUsage: mockSetThreadContextUsage },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mockLogger }));

vi.mock('../config', () => ({
  config: { llmProvider: 'bedrock' as const, contextWindowTokens: null as number | null },
}));

import { config } from '../config';
import { contextUsageService, type ContextUsageEvent } from './context-usage.service';

// 1M window, so token counts map to percentages at a 10,000:1 ratio.
const MODEL = 'us.anthropic.claude-opus-5';
const WINDOW = 1_000_000;

function baseInput(overrides: Partial<Parameters<typeof contextUsageService.record>[0]> = {}) {
  return {
    userId: 'user-1',
    threadId: 'thread-1',
    modelId: MODEL,
    inputTokens: 100_000,
    outputTokens: 0,
    ...overrides,
  };
}

/** Collect `'usage'` emissions for the duration of a test. */
function captureEmissions(): ContextUsageEvent[] {
  const seen: ContextUsageEvent[] = [];
  const listener = (event: ContextUsageEvent) => seen.push(event);
  contextUsageService.events.on('usage', listener);
  // Removed via the afterEach-equivalent below; tests are short-lived.
  emissionListeners.push(listener);
  return seen;
}
const emissionListeners: ((event: ContextUsageEvent) => void)[] = [];

describe('contextUsageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const listener of emissionListeners.splice(0)) {
      contextUsageService.events.off('usage', listener);
    }
    // The service is a singleton, so reset the cross-test state it carries.
    contextUsageService.forget('thread-1');
    config.contextWindowTokens = null;
  });

  describe('record', () => {
    it('counts input plus output tokens', () => {
      // Output counts because the reply becomes part of the next prompt.
      const snapshot = contextUsageService.record(baseInput({ inputTokens: 400_000, outputTokens: 100_000 }));

      expect(snapshot).toEqual({
        threadId: 'thread-1',
        modelId: MODEL,
        usedTokens: 500_000,
        windowTokens: WINDOW,
        usedPercent: 50,
      });
    });

    it('does not add cache tokens on top of inputTokens', () => {
      // Guards the double-counting trap: the SDK's inputTokens is ALREADY
      // inclusive of cache reads/writes. If a future change starts summing cache
      // fields, this 90 becomes something much smaller.
      const snapshot = contextUsageService.record(baseInput({ inputTokens: 100_000 }));
      expect(snapshot?.usedPercent).toBe(10);
    });

    it('returns null and emits nothing when the provider reported no usage', () => {
      const seen = captureEmissions();
      expect(contextUsageService.record(baseInput({ inputTokens: undefined }))).toBeNull();
      expect(seen).toHaveLength(0);
    });

    it('returns null and emits nothing when the model window is unknown', () => {
      const seen = captureEmissions();
      expect(contextUsageService.record(baseInput({ modelId: 'my-custom-deploy' }))).toBeNull();
      expect(seen).toHaveLength(0);
    });

    it('emits once per changed integer percentage, not once per step', () => {
      const seen = captureEmissions();

      contextUsageService.record(baseInput({ inputTokens: 100_000 })); // 90%
      contextUsageService.record(baseInput({ inputTokens: 100_400 })); // still 90% -> no emit
      contextUsageService.record(baseInput({ inputTokens: 150_000 })); // 85% -> emit

      expect(seen.map((event) => event.usedPercent)).toEqual([10, 15]);
    });

    it('includes userId on the emitted event so transports can route it', () => {
      const seen = captureEmissions();
      contextUsageService.record(baseInput());
      expect(seen[0]).toMatchObject({ userId: 'user-1', threadId: 'thread-1', modelId: MODEL });
    });

    it('clamps an overflowing prompt to 0 rather than reporting negative', () => {
      const snapshot = contextUsageService.record(baseInput({ inputTokens: WINDOW * 3 }));
      expect(snapshot?.usedPercent).toBe(100);
    });

    it('clamps to 100 rather than exceeding it', () => {
      const snapshot = contextUsageService.record(baseInput({ inputTokens: 0, outputTokens: 0 }));
      expect(snapshot?.usedPercent).toBe(0);
    });

    it('honours the env window override', () => {
      config.contextWindowTokens = 200_000;
      expect(contextUsageService.record(baseInput({ inputTokens: 100_000 }))?.usedPercent).toBe(50);
    });
  });

  describe('finalize', () => {
    it('persists the last measurement exactly once', async () => {
      contextUsageService.record(baseInput({ inputTokens: 100_000 }));
      contextUsageService.record(baseInput({ inputTokens: 412_300 }));

      await contextUsageService.finalize({ threadId: 'thread-1' });

      expect(mockSetThreadContextUsage).toHaveBeenCalledTimes(1);
      expect(mockSetThreadContextUsage).toHaveBeenCalledWith('thread-1', 412_300, MODEL);
    });

    it('does nothing when no step ever recorded usage', async () => {
      await contextUsageService.finalize({ threadId: 'never-tracked' });

      expect(mockSetThreadContextUsage).not.toHaveBeenCalled();
    });

    it('drops the thread so a second finalize is a no-op', async () => {
      contextUsageService.record(baseInput());
      await contextUsageService.finalize({ threadId: 'thread-1' });
      await contextUsageService.finalize({ threadId: 'thread-1' });

      expect(mockSetThreadContextUsage).toHaveBeenCalledTimes(1);
    });

    it('swallows a persistence failure — this is only a display metric', async () => {
      mockSetThreadContextUsage.mockRejectedValueOnce(new Error('thread vanished'));
      contextUsageService.record(baseInput());

      await expect(
        contextUsageService.finalize({ threadId: 'thread-1' })
      ).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('fromStored', () => {
    it('rebuilds a snapshot for a reload', () => {
      expect(contextUsageService.fromStored('thread-9', 250_000, MODEL)).toEqual({
        threadId: 'thread-9',
        modelId: MODEL,
        usedTokens: 250_000,
        windowTokens: WINDOW,
        usedPercent: 25,
      });
    });

    it('recomputes against the stored model, not the current one', () => {
      // Haiku's 200k window: the same token count is a very different percentage,
      // which is why contextModel is persisted alongside contextTokens.
      const snapshot = contextUsageService.fromStored('thread-9', 100_000, 'claude-haiku-4-5');
      expect(snapshot).toMatchObject({ windowTokens: 200_000, usedPercent: 50 });
    });

    it('returns null when the thread has no snapshot yet', () => {
      expect(contextUsageService.fromStored('thread-9', null, null)).toBeNull();
      expect(contextUsageService.fromStored('thread-9', 100, null)).toBeNull();
      expect(contextUsageService.fromStored('thread-9', null, MODEL)).toBeNull();
    });

    it('returns null when the stored model is no longer recognized', () => {
      expect(contextUsageService.fromStored('thread-9', 100_000, 'retired-deploy')).toBeNull();
    });
  });

  describe('forget', () => {
    it('discards in-flight state without persisting', async () => {
      contextUsageService.record(baseInput());
      contextUsageService.forget('thread-1');

      await contextUsageService.finalize({ threadId: 'thread-1' });
      expect(mockSetThreadContextUsage).not.toHaveBeenCalled();
    });
  });
});
