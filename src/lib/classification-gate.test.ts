/**
 * Classification Gate Tests
 *
 * Tests for runClassificationGate and runVerdictGate (verdict parsing, call
 * shape, error default) and isRecentDuplicate (window, trimming, missing baseline).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGenerateText, mockGetGateRequest } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetGateRequest: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

vi.mock('./classification', () => ({
  getGateRequest: mockGetGateRequest,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { runClassificationGate, runVerdictGate, isRecentDuplicate } from './classification-gate';

const baseInput = {
  system: 'Respond with exactly one word: DELIVER or SUPPRESS',
  user: '## New Report\nSomething happened.',
  functionId: 'test-gate',
  logLabel: 'Test:Gate',
};

describe('runClassificationGate', () => {
  beforeEach(() => {
    mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    mockGetGateRequest.mockReturnValue({
      model: 'classification-model',
      providerOptions: { openai: { reasoningEffort: 'none' } },
      samplingParams: { temperature: 0 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on the affirmative verdict', async () => {
    mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    await expect(runClassificationGate(baseInput)).resolves.toBe(true);
  });

  it('returns false on any other verdict', async () => {
    mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
    await expect(runClassificationGate(baseInput)).resolves.toBe(false);
  });

  it('tolerates case and surrounding whitespace in the verdict', async () => {
    mockGenerateText.mockResolvedValue({ text: '  deliver\n' });
    await expect(runClassificationGate(baseInput)).resolves.toBe(true);
  });

  it('fails open (delivers) when the call throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'));
    await expect(runClassificationGate(baseInput)).resolves.toBe(true);
  });

  it('calls the model with the gate call shape', async () => {
    await runClassificationGate(baseInput);

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'classification-model',
        // The provider's classification options ride every gate call — this
        // is what pins reasoning off for a GPT-5.x classification model.
        providerOptions: { openai: { reasoningEffort: 'none' } },
        system: baseInput.system,
        messages: [{ role: 'user', content: baseInput.user }],
        // 16 = the OpenAI Responses API minimum; a cap, so free elsewhere.
        maxOutputTokens: 16,
        // Comes from the provider's samplingParams — omitted on openai.
        temperature: 0,
      }),
    );
  });

  it('omits temperature entirely when the provider declares empty sampling params', async () => {
    mockGetGateRequest.mockReturnValue({
      model: 'classification-model',
      providerOptions: { openai: { reasoningEffort: 'none' } },
      samplingParams: {},
    });

    await runClassificationGate(baseInput);

    expect(mockGenerateText.mock.calls[0][0]).not.toHaveProperty('temperature');
    // Langfuse disabled in tests → no tracing options on the call
    expect(mockGenerateText.mock.calls[0][0]).not.toHaveProperty('experimental_telemetry');
  });
});

describe('runVerdictGate', () => {
  beforeEach(() => {
    mockGetGateRequest.mockReturnValue({
      model: 'classification-model',
      providerOptions: {},
      samplingParams: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the verdict upper-cased and trimmed', async () => {
    mockGenerateText.mockResolvedValue({ text: ' repeat\n' });
    await expect(runVerdictGate(baseInput)).resolves.toBe('REPEAT');
  });

  it('fails open to DELIVER when the call throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'));
    await expect(runVerdictGate(baseInput)).resolves.toBe('DELIVER');
  });
});

describe('isRecentDuplicate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for an exact trimmed match within the window', () => {
    const last = { text: 'Disk usage at 91%', at: Date.now() - 60 * 60 * 1000 };
    expect(isRecentDuplicate(last, '  Disk usage at 91%\n')).toBe(true);
  });

  it('returns false once the 24h window has passed', () => {
    const at = Date.now() - 25 * 60 * 60 * 1000;
    expect(isRecentDuplicate({ text: 'Disk usage at 91%', at }, 'Disk usage at 91%')).toBe(false);
  });

  it('returns false for different text', () => {
    const last = { text: 'Disk usage at 91%', at: Date.now() };
    expect(isRecentDuplicate(last, 'Disk usage at 95%')).toBe(false);
  });

  it('returns false without a baseline', () => {
    expect(isRecentDuplicate(null, 'Disk usage at 91%')).toBe(false);
    expect(isRecentDuplicate(undefined, 'Disk usage at 91%')).toBe(false);
    expect(isRecentDuplicate({ text: '', at: Date.now() }, '')).toBe(false);
  });
});
