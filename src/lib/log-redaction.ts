/**
 * Errors, reduced to what an operator needs — and to nothing a log must not hold.
 *
 * The AI SDK's `APICallError` carries the request it sent and the response it got
 * as *own enumerable* properties: `requestBodyValues`, `responseBody`,
 * `responseHeaders`, `data`. Pino serialises all of them, so a single
 * `logger.error({ err }, 'gate call failed')` writes the entire prompt into the
 * log — including whatever a person said in a meeting, and whatever the vendor
 * echoed back. Measured against the versions this repo pins (ai 6, pino 10) it
 * happens for `logger.error(err, msg)` and `logger.error({ err }, msg)` alike, and
 * no log level suppresses it: an error log is not something you turn down.
 *
 * One serializer on the one pino instance, rather than an edit at each of the forty
 * or so `{ err }` call sites, because the call site added next month has to be safe
 * as well and nobody will remember this rule.
 *
 * **An allow-list, not a deny-list.** A deny-list is correct until an SDK adds a
 * field, and being wrong costs a leaked prompt. So the shape of a loggable error is
 * enumerated here and every other field goes — but what went is *named*, so the log
 * still says what it is not telling you instead of quietly looking complete.
 *
 * What this cannot promise is that no content whatsoever reaches a log, because
 * `message` is kept and some errors are *built* by interpolating content into it —
 * the SDK's `JSONParseError` quotes the text it failed to parse, `TypeValidationError`
 * the value it rejected. Both are model output rather than anything we sent, and
 * dropping `message` would leave an error log saying nothing at all. So: no request
 * body, no response body, no headers; a message that may quote what a model returned.
 */

/**
 * The keys an error may keep, and the reason each is safe.
 *
 * All of them are either the vendor's own vocabulary (`name`, `code`, `errno`,
 * `syscall`, `statusCode`, `isRetryable`, `reason` — the SDK's retry verdict, e.g.
 * `maxRetriesExceeded`) or text this codebase wrote (`message`, `stack`). None of
 * them is content we sent to a model or content a model sent back. Anything whose
 * value is not a primitive is dropped even when its key is listed here, so a key
 * cannot smuggle an object graph in behind a safe name.
 */
const ALLOWED_KEYS = [
  'name',
  'message',
  'stack',
  'code',
  'errno',
  'syscall',
  'statusCode',
  'url',
  'isRetryable',
  'reason',
] as const;

/**
 * Where an error hides another error.
 *
 * `cause` is the language's own chain; `lastError` is the AI SDK's retry wrapper,
 * which fails with a `RetryError` holding the `APICallError` that actually
 * happened. Both are reduced to a name and a message — enough to say what went
 * wrong underneath, and one level deep only, so nesting cannot walk back to a
 * request body two links down.
 */
const NESTED_KEYS = ['cause', 'lastError'] as const;

/**
 * Where an error hides *several* errors.
 *
 * `AggregateError` and the SDK's `RetryError` both keep the whole run of failed
 * attempts here, and `lastError` alone hides whether the earlier attempts failed
 * differently — a 429 then a 500 is a different story from three 500s. Same
 * one-level reduction, and bounded, because this one is a list and a log line
 * should not grow with it.
 */
const LIST_KEY = 'errors';
const LIST_LIMIT = 5;

/**
 * The one nested object read for a value rather than reduced to a name.
 *
 * AWS SDK v3 errors — Titan embeddings come through `@aws-sdk/client-bedrock-runtime`
 * — put the HTTP status nowhere else: there is no `statusCode`, only
 * `$metadata.httpStatusCode`. Dropping the object because it is an object would log a
 * 403 with no indication that it was a 403. Only that one number is lifted out;
 * `$metadata`'s remaining fields are request ids and attempt counts, and it still
 * shows up as redacted, which is true — it was not kept whole.
 */
const METADATA_KEY = '$metadata';

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A nested error as a name and a message. Never recurses. */
function summarize(value: unknown): Record<string, unknown> | string {
  if (value === null || typeof value !== 'object') return String(value);
  const nested = value as { name?: unknown; message?: unknown };
  return {
    name: isPrimitive(nested.name) ? nested.name : (value.constructor?.name ?? 'Error'),
    message: isPrimitive(nested.message) ? nested.message : '(no message)',
  };
}

/**
 * Pino's `err` serializer: replaces the default, which copies every own property.
 *
 * Takes `unknown` because it has to. A `catch` block receives whatever was thrown,
 * and the one this exists for (`addressed-classifier.ts`) is no exception — a
 * string, `undefined` or a plain object all have to come out as something readable
 * rather than as a crash inside the logger.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: typeof err === 'string' ? err : String(err) };
  }

  const source = err as Record<string, unknown>;
  const out: Record<string, unknown> = {
    // Matches pino's own default, which reports the constructor name as `type` —
    // the field operators grep for, and the one thing `message` alone won't say.
    type: err instanceof Error ? (err.constructor?.name ?? 'Error') : 'object',
  };

  // Read through the property, not through `Object.keys`: `message` and `stack` are
  // inherited on some errors, and `cause` set via `new Error(msg, { cause })` is own
  // but *not* enumerable. `errors` on an `AggregateError` is own but non-enumerable
  // too, so a list read this way is one `Object.keys` would have missed entirely.
  //
  // An `undefined` value counts as kept even though nothing is written for it: the
  // SDK's `APICallError` declares `cause` whether or not it has one, and reporting
  // an absent field as *redacted* would say something was withheld when there was
  // nothing there to withhold.
  const kept = new Set<string>();
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value === undefined) {
      kept.add(key);
      continue;
    }
    if (!isPrimitive(value)) continue;
    out[key] = value;
    kept.add(key);
  }

  if (out.statusCode === undefined) {
    const metadata = source[METADATA_KEY];
    if (metadata !== null && typeof metadata === 'object') {
      const status = (metadata as Record<string, unknown>).httpStatusCode;
      if (typeof status === 'number') out.statusCode = status;
    }
  }

  for (const key of NESTED_KEYS) {
    if (source[key] === undefined) {
      kept.add(key);
      continue;
    }
    out[key] = summarize(source[key]);
    kept.add(key);
  }

  const list = source[LIST_KEY];
  if (Array.isArray(list)) {
    const summaries: (Record<string, unknown> | string)[] = list.slice(0, LIST_LIMIT).map(summarize);
    if (list.length > LIST_LIMIT) summaries.push(`(+${list.length - LIST_LIMIT} more)`);
    out[LIST_KEY] = summaries;
    kept.add(LIST_KEY);
  } else if (list === undefined) {
    kept.add(LIST_KEY);
  }

  // Named rather than silently gone. An operator reading `redacted:
  // ["requestBodyValues","responseBody"]` knows the vendor did answer and where to
  // look for the body (the vendor's own logs, or a local reproduction) instead of
  // assuming the request never left.
  const redacted = Object.keys(source)
    .filter((key) => !kept.has(key))
    .sort();
  if (redacted.length > 0) out.redacted = redacted;

  return out;
}
