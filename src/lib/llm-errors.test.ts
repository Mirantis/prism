import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../logger';
import {
  isSpendingLimitError,
  getSpendingLimitDetail,
  getErrorDetail,
  isContextOverflowError,
  logSpendingLimitWarning,
  buildErrorStep,
} from './llm-errors';

describe('isSpendingLimitError', () => {
  it('returns true for 429 with budget-exceeded type in responseBody', () => {
    expect(isSpendingLimitError({
      status: 429,
      responseBody: JSON.stringify({
        type: 'budget-exceeded',
        title: 'Budget Exceeded',
        detail: 'Monthly org budget: $0.50 of $0.50 used',
      }),
    })).toBe(true);
  });

  it('returns true for 429 with budget-exceeded type in body (object)', () => {
    expect(isSpendingLimitError({
      status: 429,
      body: {
        type: 'budget-exceeded',
        detail: 'Weekly budget exhausted',
      },
    })).toBe(true);
  });

  it('returns true for 429 with budget-exceeded in response.data', () => {
    expect(isSpendingLimitError({
      status: 429,
      response: {
        data: { type: 'budget-exceeded' },
      },
    })).toBe(true);
  });

  it('returns true via statusCode field', () => {
    expect(isSpendingLimitError({
      statusCode: 429,
      responseBody: JSON.stringify({ type: 'budget-exceeded' }),
    })).toBe(true);
  });

  it('returns false for non-429 status', () => {
    expect(isSpendingLimitError({
      status: 500,
      responseBody: JSON.stringify({ type: 'budget-exceeded' }),
    })).toBe(false);
  });

  it('returns false for 429 without budget-exceeded type', () => {
    expect(isSpendingLimitError({ status: 429, message: 'throttled' })).toBe(false);
  });

  it('returns false for 429 with different type', () => {
    expect(isSpendingLimitError({
      status: 429,
      responseBody: JSON.stringify({ type: 'rate-limit' }),
    })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isSpendingLimitError(null)).toBe(false);
    expect(isSpendingLimitError(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isSpendingLimitError('error')).toBe(false);
  });
});

describe('getSpendingLimitDetail', () => {
  it('returns detail from responseBody', () => {
    expect(getSpendingLimitDetail({
      status: 429,
      responseBody: JSON.stringify({
        type: 'budget-exceeded',
        detail: 'Monthly budget of $100 reached',
      }),
    })).toBe('Monthly budget of $100 reached');
  });

  it('returns detail from body object', () => {
    expect(getSpendingLimitDetail({
      status: 429,
      body: {
        type: 'budget-exceeded',
        detail: 'Weekly budget exhausted',
      },
    })).toBe('Weekly budget exhausted');
  });

  it('returns null when no detail field', () => {
    expect(getSpendingLimitDetail({
      status: 429,
      responseBody: JSON.stringify({ type: 'budget-exceeded' }),
    })).toBeNull();
  });

  it('returns null for non-budget error', () => {
    expect(getSpendingLimitDetail({ status: 500 })).toBeNull();
  });
});

describe('getErrorDetail', () => {
  it('returns detail from responseBody JSON', () => {
    expect(getErrorDetail({
      status: 502,
      responseBody: JSON.stringify({ detail: 'upstream timeout' }),
    })).toBe('upstream timeout');
  });

  it('returns detail from body object', () => {
    expect(getErrorDetail({
      status: 400,
      body: { detail: 'malformed request' },
    })).toBe('malformed request');
  });

  it('returns detail from response.data', () => {
    expect(getErrorDetail({
      response: { data: { detail: 'nested detail' } },
    })).toBe('nested detail');
  });

  it('returns null when body has no detail field', () => {
    expect(getErrorDetail({
      responseBody: JSON.stringify({ message: 'no detail key' }),
    })).toBeNull();
  });

  it('returns null when body is not parseable JSON', () => {
    // tryParseJson swallows the parse error and returns the raw string,
    // which is not an object, so detail extraction fails gracefully.
    expect(getErrorDetail({ responseBody: 'not-json' })).toBeNull();
  });

  it('returns null for null/undefined/non-object', () => {
    expect(getErrorDetail(null)).toBeNull();
    expect(getErrorDetail(undefined)).toBeNull();
    expect(getErrorDetail('string error')).toBeNull();
  });
});

describe('logSpendingLimitWarning', () => {
  it('logs a warning with the detail when present', () => {
    vi.mocked(logger.warn).mockClear();
    logSpendingLimitWarning({
      status: 429,
      responseBody: JSON.stringify({
        type: 'budget-exceeded',
        detail: 'Weekly budget exceeded',
      }),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Weekly budget exceeded'),
    );
  });

  it('logs a generic message when detail is missing', () => {
    vi.mocked(logger.warn).mockClear();
    logSpendingLimitWarning({
      status: 429,
      responseBody: JSON.stringify({ type: 'budget-exceeded' }),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('budget exhausted'),
    );
  });

  it('does not throw on malformed input (best-effort)', () => {
    expect(() => logSpendingLimitWarning(null)).not.toThrow();
    expect(() => logSpendingLimitWarning('bad')).not.toThrow();
  });
});

describe('buildErrorStep', () => {
  it('returns a friendly budget step with structured error metadata when given a budget-exceeded 429', () => {
    const step = buildErrorStep({
      status: 429,
      responseBody: JSON.stringify({
        type: 'budget-exceeded',
        detail: 'Monthly budget: $5 of $5 used',
      }),
    });

    expect(step.text).toContain("AI spending limit has been reached");
    expect(step.text).toContain('Monthly budget: $5 of $5 used');
    expect(step.toolCalls).toEqual([]);
    expect(step.error).toEqual({
      type: 'budget_exceeded',
      detail: 'Monthly budget: $5 of $5 used',
    });
  });

  it('omits the detail clause when the budget error has no detail field', () => {
    const step = buildErrorStep({
      status: 429,
      responseBody: JSON.stringify({ type: 'budget-exceeded' }),
    });

    expect(step.text).toContain('AI spending limit has been reached');
    // No `:` colon-prefixed detail snippet, just the base sentence.
    expect(step.text).not.toMatch(/AI spending limit has been reached:/);
    expect(step.error).toEqual({ type: 'budget_exceeded', detail: null });
  });

  it('unwraps an SDK-wrapped error via lastError to detect budget', () => {
    const original = {
      status: 429,
      responseBody: JSON.stringify({
        type: 'budget-exceeded',
        detail: 'wrapped detail',
      }),
    };
    const wrapped = Object.assign(new Error('Failed after 3 attempts'), {
      lastError: original,
    });

    const step = buildErrorStep(wrapped);

    expect(step.error).toEqual({ type: 'budget_exceeded', detail: 'wrapped detail' });
    expect(step.text).toContain('wrapped detail');
  });

  it('produces a generic friendly message for non-budget Error instances', () => {
    const step = buildErrorStep(new Error('Model timeout'));

    expect(step.text).toContain('I encountered an error while processing your request');
    expect(step.text).toContain('Model timeout');
    expect(step.toolCalls).toEqual([]);
    expect(step.error).toBeUndefined();
  });

  it('prefers the RFC 7807 detail over the raw error message for non-budget errors', () => {
    // 4xx with a problem-details body — surface the server's `detail` text
    // rather than the bare `Error.message` ("400").
    const step = buildErrorStep(Object.assign(new Error('400'), {
      status: 400,
      responseBody: JSON.stringify({ detail: 'invalid prompt' }),
    }));

    expect(step.text).toContain('invalid prompt');
    expect(step.text).not.toContain(': 400');
  });

  it('falls back to "Unknown error" when given a non-Error value', () => {
    const step = buildErrorStep('a string was thrown');

    expect(step.text).toContain('Unknown error');
    expect(step.error).toBeUndefined();
  });

  it('logs the error message and responseBody on failure', () => {
    vi.mocked(logger.error).mockClear();
    buildErrorStep(Object.assign(new Error('boom'), { responseBody: '{"x":1}' }));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('{"x":1}'));
  });
});

describe('isContextOverflowError', () => {
  it('matches the Anthropic direct message', () => {
    expect(
      isContextOverflowError(new Error('prompt is too long: 213456 tokens > 200000 maximum')),
    ).toBe(true);
  });

  it('matches the Bedrock ValidationException message', () => {
    expect(isContextOverflowError(new Error('Input is too long for requested model.'))).toBe(true);
  });

  it('matches the context_length_exceeded code in a response body', () => {
    expect(
      isContextOverflowError({
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { code: 'context_length_exceeded', message: 'too big' },
        }),
      }),
    ).toBe(true);
  });

  it('treats HTTP 413 as overflow', () => {
    expect(isContextOverflowError({ statusCode: 413 })).toBe(true);
  });

  it('unwraps the SDK retry wrapper (lastError)', () => {
    expect(
      isContextOverflowError({ lastError: new Error('prompt is too long: 9 tokens > 1 maximum') }),
    ).toBe(true);
  });

  it('rejects unrelated errors — a generic failure must not trigger compaction', () => {
    expect(isContextOverflowError(new Error('rate limited'))).toBe(false);
    expect(isContextOverflowError(new Error('The security token is invalid'))).toBe(false);
    expect(
      isContextOverflowError({
        status: 429,
        responseBody: JSON.stringify({ type: 'budget-exceeded', detail: 'x' }),
      }),
    ).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError('prompt is too long')).toBe(false);
  });
});
