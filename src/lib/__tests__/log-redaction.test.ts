/**
 * Proof that an error log cannot carry a prompt or a response body.
 *
 * Written against a **real pino instance** rather than the mocked logger the rest of
 * the suite uses. The bug this covers lives entirely in serialisation: a mocked
 * logger records the object it was handed and would pass whatever the serializer
 * does or does not do. So the assertions read the JSON line pino actually writes.
 *
 * The error is a real `APICallError` from the SDK, carrying a real gate prompt and a
 * sentence standing in for private user content — the exact payload shape that
 * reached production logs.
 *
 * The prompt is the scheduled-task gate's because it is a real, surviving
 * `generateText` payload. It used to be the meeting addressed-gate's, which was the
 * call that produced the production leak; that gate now judges audio over a
 * WebSocket and builds no such prompt, so the payload had to come from one of the
 * gates that still makes one. What is being proved is a property of the serializer,
 * not of any one caller.
 */

import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';
import pino from 'pino';
import { serializeError } from '../log-redaction';
import { logger } from '../../logger';
import { CRON_TASK_GATE_PROMPT } from '../../prompts/cron-prompt';

const TRANSCRIPT = 'Emma, can you take a look at the staging cluster?';
const RESPONSE_BODY = '{"message":"model access denied for account 1234"}';
const HEADER_VALUE = 'req-abc-secret-header';

function apiError(overrides: Partial<Parameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: 'Bad Request',
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/haiku/converse',
    requestBodyValues: {
      system: CRON_TASK_GATE_PROMPT,
      messages: [{ role: 'user', content: `Assistant's name: Emma\nSentence: ${TRANSCRIPT}` }],
    },
    statusCode: 400,
    responseHeaders: { 'x-amzn-requestid': HEADER_VALUE },
    responseBody: RESPONSE_BODY,
    isRetryable: false,
    data: { detail: TRANSCRIPT },
    ...overrides,
  });
}

/** A logger writing real pino lines to an array, wired exactly as `logger.ts` is. */
function capturing(): { lines: string[]; log: pino.Logger } {
  const lines: string[] = [];
  const log = pino(
    { level: 'info', serializers: { err: serializeError } },
    { write: (line: string) => lines.push(line) },
  );
  return { lines, log };
}

describe('serializing an error into a log', () => {
  it('writes neither the request it sent nor the response it got', () => {
    const { lines, log } = capturing();

    log.error({ err: apiError() }, '[Cron] Gate call failed');

    const line = lines.join('\n');
    // The user's own content, and the prompt it was judged with.
    expect(line).not.toContain(TRANSCRIPT);
    expect(line).not.toContain('decide whether its result should be delivered');
    expect(line).not.toContain('Emma');
    // What the vendor sent back, headers included.
    expect(line).not.toContain(RESPONSE_BODY);
    expect(line).not.toContain('model access denied');
    expect(line).not.toContain(HEADER_VALUE);
  });

  it('still says enough to diagnose the failure', () => {
    const { lines, log } = capturing();

    log.error({ err: apiError() }, 'gate call failed');

    // Redaction that blinds the operator would just move the outage. The vendor,
    // the endpoint, the status and the SDK's own error type all survive.
    const entry = JSON.parse(lines[0]) as { err: Record<string, unknown> };
    expect(entry.err.type).toBe('APICallError');
    expect(entry.err.message).toBe('Bad Request');
    expect(entry.err.statusCode).toBe(400);
    expect(entry.err.url).toContain('bedrock-runtime');
    expect(entry.err.isRetryable).toBe(false);
    expect(entry.err.stack).toContain('APICallError');
  });

  it('names what it dropped, so the log does not read as complete', () => {
    const { lines, log } = capturing();

    log.error({ err: apiError() }, 'gate call failed');

    // Otherwise an operator cannot tell "the vendor returned no body" from "the body
    // was withheld", and spends the outage on the wrong question.
    const entry = JSON.parse(lines[0]) as { err: { redacted?: string[] } };
    expect(entry.err.redacted).toEqual(
      expect.arrayContaining(['requestBodyValues', 'responseBody', 'responseHeaders', 'data']),
    );
    // And nothing it did not drop. The SDK declares `cause` on every `APICallError`
    // whether or not one was passed, so an own-but-`undefined` property listed here
    // would send an operator looking for a chained error that never existed.
    expect(entry.err.redacted).not.toContain('cause');
  });

  it('names a dropped field that was hidden from an enumeration', () => {
    const { lines, log } = capturing();
    // Own but non-enumerable, which is how `AggregateError` keeps `errors` — so the
    // read loop sees fields an `Object.keys` walk does not. If the report of what was
    // dropped were built from that walk instead, such a field would vanish with no
    // trace, which is the one thing this array exists to prevent.
    const err = new Error('upload failed');
    Object.defineProperty(err, 'payload', { value: TRANSCRIPT, enumerable: false });

    log.error({ err }, 'hidden field');

    const entry = JSON.parse(lines[0]) as { err: { redacted?: string[] } };
    expect(entry.err.redacted).toContain('payload');
    expect(lines[0]).not.toContain(TRANSCRIPT);
  });

  it('reduces a nested error to a name and a message', () => {
    const { lines, log } = capturing();

    log.error({ err: new Error('wrapping', { cause: apiError() }) }, 'wrapped');

    const entry = JSON.parse(lines[0]) as { err: { cause?: Record<string, unknown> } };
    expect(entry.err.cause).toEqual({ name: 'AI_APICallError', message: 'Bad Request' });
    expect(lines.join('\n')).not.toContain(TRANSCRIPT);
    expect(lines.join('\n')).not.toContain(RESPONSE_BODY);
  });

  it("keeps the retry wrapper's underlying error readable without its body", () => {
    const { lines, log } = capturing();
    const inner = apiError({ message: 'Too many requests', statusCode: 429 });

    log.error(
      { err: new RetryError({ message: 'failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [inner] }) },
      'retries exhausted',
    );

    // The SDK hangs the error that actually happened off `lastError`, so dropping it
    // outright would reduce every retried failure to "failed after 3 attempts".
    const entry = JSON.parse(lines[0]) as {
      err: { lastError?: Record<string, unknown>; reason?: string; errors?: unknown[] };
    };
    expect(entry.err.lastError).toEqual({ name: 'AI_APICallError', message: 'Too many requests' });
    // Why it gave up, and every attempt rather than only the last: a 429 followed by
    // a 500 is a different outage from three 500s, and `lastError` alone hides that.
    expect(entry.err.reason).toBe('maxRetriesExceeded');
    expect(entry.err.errors).toEqual([{ name: 'AI_APICallError', message: 'Too many requests' }]);
    expect(lines.join('\n')).not.toContain(TRANSCRIPT);
    expect(lines.join('\n')).not.toContain(RESPONSE_BODY);
  });

  it('bounds a list of attempts instead of letting the line grow with it', () => {
    const { lines, log } = capturing();
    const many = Array.from({ length: 7 }, (_, i) => apiError({ message: `attempt ${i}` }));

    log.error({ err: new AggregateError(many, 'everything failed') }, 'aggregate');

    // `AggregateError.errors` is own but *non-enumerable*, so this is a list pino's
    // own `Object.keys` walk would never have seen — and one a wide fan-out can make
    // arbitrarily long.
    const entry = JSON.parse(lines[0]) as { err: { errors?: unknown[] } };
    expect(entry.err.errors).toHaveLength(6);
    expect(entry.err.errors?.[0]).toEqual({ name: 'AI_APICallError', message: 'attempt 0' });
    expect(entry.err.errors?.[5]).toBe('(+2 more)');
    expect(lines.join('\n')).not.toContain(TRANSCRIPT);
  });

  it('redacts whichever way the error was handed to the logger', () => {
    const { lines, log } = capturing();

    // All three shapes appear across the codebase, and pino routes them differently.
    log.error(apiError(), 'error as the first argument');
    log.error({ err: apiError() }, 'error under err');
    log.error({ err: apiError(), threadId: 'thread-9' }, 'error alongside context');

    const all = lines.join('\n');
    expect(all).not.toContain(TRANSCRIPT);
    expect(all).not.toContain(RESPONSE_BODY);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect((JSON.parse(line) as { err: { statusCode?: number } }).err.statusCode).toBe(400);
    }
    // Context the caller added is not an error and must survive untouched.
    expect((JSON.parse(lines[2]) as { threadId?: string }).threadId).toBe('thread-9');
  });

  it("recovers an AWS error's status code from the metadata it hides it in", () => {
    const { lines, log } = capturing();
    // The shape `@aws-sdk/client-bedrock-runtime` throws — no `statusCode` anywhere,
    // so dropping the object for being an object logs a 403 as an untyped failure.
    const awsError = Object.assign(new Error('User is not authorized'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId: 'req-77', attempts: 1, totalRetryDelay: 0 },
    });

    log.error({ err: awsError }, 'embedding failed');

    const entry = JSON.parse(lines[0]) as { err: { statusCode?: number; redacted?: string[] } };
    expect(entry.err.statusCode).toBe(403);
    // Only that number was lifted out, so the object is still reported as withheld.
    expect(entry.err.redacted).toContain('$metadata');
    expect(lines[0]).not.toContain('req-77');
  });

  it('handles a plain error and a value that was never an error', () => {
    const { lines, log } = capturing();

    log.error({ err: new Error('disk is full') }, 'plain');
    log.error({ err: 'a string was thrown' }, 'string');

    const plain = JSON.parse(lines[0]) as { err: Record<string, unknown> };
    expect(plain.err.type).toBe('Error');
    expect(plain.err.message).toBe('disk is full');
    expect(plain.err.stack).toContain('disk is full');
    expect(plain.err.redacted).toBeUndefined();

    // A `catch` binding is `unknown`, so a thrown string has to come out readable.
    expect(JSON.parse(lines[1])).toMatchObject({
      err: { type: 'string', message: 'a string was thrown' },
    });

    // `undefined` and `null` never reach pino as a value it will serialise, so they
    // are asserted on the function: the serializer must not throw inside the logger.
    expect(serializeError(undefined)).toEqual({ type: 'undefined', message: 'undefined' });
    expect(serializeError(null)).toEqual({ type: 'object', message: 'null' });
  });

  it('is installed on the logger the runtime actually uses', () => {
    // Everything above proves the serializer redacts. This proves it is wired in —
    // the failure mode that would leave the tests green while every real
    // `logger.error({ err }, …)` in the process went on writing prompts.
    const serializers = (logger as unknown as Record<symbol, Record<string, unknown>>)[
      pino.symbols.serializersSym
    ];
    expect(serializers.err).toBe(serializeError);
  });
});
