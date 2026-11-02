/**
 * LLM Error Classification
 *
 * Detects gateway budget-exceeded errors (RFC 7807) from LLM call failures.
 * The AI SDK retries transient 429s internally — this module identifies
 * permanent budget errors that should not be retried.
 */

import { logger } from '../logger';
import type { InvokeStep } from '../types';

/**
 * Check if an error is a gateway budget-exceeded 429.
 *
 * The Lens Agents gateway returns RFC 7807 problem details with
 * `type: "budget-exceeded"`.
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
 * Message patterns the providers use for "the request does not fit the
 * model's context window". Anthropic direct says "prompt is too long:
 * 213456 tokens > 200000 maximum"; Bedrock's ValidationException says
 * "Input is too long for requested model"; OpenAI-compatible gateways use
 * the `context_length_exceeded` code. Deliberately narrow — a generic
 * "too long"/"context" match would misfire on unrelated validation text.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /exceeds? (the )?(maximum )?context/i,
  /too many (input )?tokens/i,
];

/**
 * Check if an error means the request outgrew the model's context window.
 *
 * Consumed by the compaction overflow-recovery path: a turn that fails this
 * way will fail identically on every retry until the thread is compacted, so
 * it is the one error class where acting on the failure is correct. Unwraps
 * the SDK's `lastError` retry wrapper like `buildErrorStep` does.
 */
export function isContextOverflowError(error: unknown): boolean {
  const unwrapped = (error && typeof error === 'object' && 'lastError' in error)
    ? (error as { lastError: unknown }).lastError
    : error;
  if (!unwrapped || typeof unwrapped !== 'object') return false;

  const err = unwrapped as Record<string, unknown>;
  if (getStatusCode(err) === 413) return true;

  const texts: string[] = [];
  if (unwrapped instanceof Error) texts.push(unwrapped.message);
  const detail = getErrorDetail(unwrapped);
  if (detail) texts.push(detail);
  const body = getResponseBody(err);
  if (typeof body === 'string') texts.push(body);
  else if (body && typeof body === 'object') {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string') texts.push(message);
    const errObj = (body as Record<string, unknown>).error;
    if (errObj && typeof errObj === 'object') {
      const m = (errObj as Record<string, unknown>).message;
      if (typeof m === 'string') texts.push(m);
      const code = (errObj as Record<string, unknown>).code;
      if (typeof code === 'string') texts.push(code);
    }
  }

  return texts.some((text) => CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(text)));
}

/**
 * Check if the API refused the request itself (400) for a reason other than
 * its size. Unwraps the SDK's `lastError` retry wrapper.
 */
export function isRejectedRequestError(error: unknown): boolean {
  const unwrapped = (error && typeof error === 'object' && 'lastError' in error)
    ? (error as { lastError: unknown }).lastError
    : error;
  if (!unwrapped || typeof unwrapped !== 'object') return false;
  return getStatusCode(unwrapped as Record<string, unknown>) === 400 && !isContextOverflowError(unwrapped);
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

  // Handed over as `err` so the redacting serializer sees it. This used to also log
  // `responseBody` verbatim, which is the one field guaranteed to quote back whatever
  // was sent — including a meeting's transcript on a failed gate call.
  logger.error({ err: error }, 'Invocation failed');

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
    error: { type: 'generic', detail: errorDetail },
  };
}

/**
 * The model declined the request outright.
 *
 * A refusal is not a failure: it arrives as a 200 with `finishReason:
 * 'content-filter'`, with the refusal written out or with no text at all. In
 * the silent shape the engine has nothing to publish; this is the one place
 * that turns that outcome into something a user can read.
 *
 * Untagged on purpose. `InvokeError` marks a turn that went wrong so callers
 * can react — route around the cron gate, detect an exhausted budget — and a
 * refusal is an ordinary final answer that happens to be no.
 */
export function buildRefusalStep(): InvokeStep {
  return {
    text:
      "I can't help with that request. If that seems wrong, tell me more about what you " +
      'are trying to do and I will take another look.',
    toolCalls: [],
  };
}

function tryParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}
