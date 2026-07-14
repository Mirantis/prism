/**
 * LLM Error Classification
 *
 * Detects Nexus budget-exceeded errors (RFC 7807) from LLM call failures.
 * The AI SDK retries transient 429s internally — this module identifies
 * permanent budget errors that should not be retried.
 */

import { logger } from '../logger';
import type { InvokeStep } from '../types';

/**
 * Check if an error is a Nexus budget-exceeded 429.
 *
 * Nexus returns RFC 7807 problem details with `type: "budget-exceeded"`.
 * Unlike throttling 429s, these won't resolve by waiting.
 */
export function isSpendingLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;
  const status = getStatusCode(err);
  if (status !== 429) return false;

  const body = getResponseBody(err);
  if (!body || typeof body !== 'object') return false;

  const problemType = (body as Record<string, unknown>).type;
  return typeof problemType === 'string' && problemType.includes('budget-exceeded');
}

/**
 * Extract user-friendly detail from a budget-exceeded error.
 *
 * Returns the RFC 7807 `detail` field (e.g. "Weekly budget: $4.96 of $4.00 used"),
 * or null if not available.
 */
export function getSpendingLimitDetail(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;

  const err = error as Record<string, unknown>;
  const body = getResponseBody(err);
  if (!body || typeof body !== 'object') return null;

  const detail = (body as Record<string, unknown>).detail;
  return typeof detail === 'string' ? detail : null;
}

/**
 * Log a warning when a budget-exceeded error is detected.
 */
export function logSpendingLimitWarning(error: unknown): void {
  try {
    const detail = getSpendingLimitDetail(error);
    logger.warn(
      `[LLM] Budget exceeded: ${detail ?? 'budget exhausted'}. ` +
      'Requests will fail until the limit resets or is increased.',
    );
  } catch {
    // Best-effort logging
  }
}

/** Extract HTTP status code from various error shapes. */
function getStatusCode(err: Record<string, unknown>): number | null {
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;

  const response = err.response as Record<string, unknown> | undefined;
  if (response && typeof response === 'object') {
    if (typeof response.status === 'number') return response.status;
    if (typeof response.statusCode === 'number') return response.statusCode;
  }

  const data = err.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && typeof data.status === 'number') {
    return data.status;
  }

  return null;
}

/** Extract response body from various error shapes. */
function getResponseBody(err: Record<string, unknown>): unknown {
  if (err.responseBody !== undefined) return tryParseJson(err.responseBody);
  if (err.body !== undefined) return tryParseJson(err.body);

  const response = err.response as Record<string, unknown> | undefined;
  if (response && typeof response === 'object') {
    if (response.body !== undefined) return tryParseJson(response.body);
    if (response.data !== undefined) return response.data;
  }

  const data = err.data;
  if (data !== undefined) return tryParseJson(data);

  return null;
}

/**
 * Extract the RFC 7807 `detail` field from an HTTP error response.
 *
 * Works for any error that carries a problem-details body, not just
 * budget-exceeded 429s. Returns the detail string or null.
 */
export function getErrorDetail(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;

  const err = error as Record<string, unknown>;
  const body = getResponseBody(err);
  if (!body || typeof body !== 'object') return null;

  const detail = (body as Record<string, unknown>).detail;
  return typeof detail === 'string' ? detail : null;
}

/**
 * Build a friendly InvokeStep from a runtime error.
 *
 * The single place that turns an LLM/runtime error into user-facing text.
 * invokeStream's catch paths use this; invoke() and conversation-engine
 * just see the resulting step like any other yielded step.
 *
 * Unwraps SDK-wrapped errors (the AI SDK retries internally and wraps the
 * final failure with a `lastError` field), then classifies budget vs.
 * generic.
 */
export function buildErrorStep(error: unknown): InvokeStep {
  const message = error instanceof Error ? error.message : 'Unknown error';

  logger.error(`Invocation failed: ${message}`);

  if (error && typeof error === 'object' && 'responseBody' in error) {
    logger.error(`Response body: ${(error as { responseBody: unknown }).responseBody}`);
  }

  // The SDK wraps retried errors — unwrap lastError to check the original
  const originalError = (error && typeof error === 'object' && 'lastError' in error)
    ? (error as { lastError: unknown }).lastError
    : error;

  if (isSpendingLimitError(originalError)) {
    logSpendingLimitWarning(originalError);
    const detail = getSpendingLimitDetail(originalError);
    return {
      text:
        `Your organization's AI spending limit has been reached` +
        `${detail ? `: ${detail}` : ''}. ` +
        'Please contact your administrator to increase the budget or wait for the limit to reset.',
      toolCalls: [],
      error: { type: 'budget_exceeded', detail },
    };
  }

  const errorDetail = getErrorDetail(originalError);
  return {
    text: `I encountered an error while processing your request: ${errorDetail || message}`,
    toolCalls: [],
    // Marked so streaming consumers (conversation-engine) can tell a
    // synthetic error step from ordinary model output — e.g. to avoid letting
    // a late failure replace the useful output completed in earlier steps.
    error: { type: 'llm_error' },
  };
}

function tryParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}
