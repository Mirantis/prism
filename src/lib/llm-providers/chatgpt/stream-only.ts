/**
 * Serves a non-streaming call from the model's stream, for an endpoint that
 * answers only streamed requests. The parts are collected into the result the
 * call would have returned, so callers keep using `generateText`.
 */

import { APICallError, type LanguageModelMiddleware } from 'ai';

type WrapGenerate = NonNullable<LanguageModelMiddleware['wrapGenerate']>;
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type StreamResult = Awaited<ReturnType<Parameters<WrapGenerate>[0]['doStream']>>;
type Content = GenerateResult['content'][number];
type ProviderMetadata = GenerateResult['providerMetadata'];

// The Responses API events that end a response. A stream that closes before one
// of them is a truncated answer, though the SDK still ends it with a finish part.
const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

interface OpenPart {
  type: 'text' | 'reasoning';
  text: string;
  providerMetadata?: ProviderMetadata;
}

async function collectStream(
  { stream, request, response }: StreamResult,
  url: string,
): Promise<GenerateResult> {
  const content: Content[] = [];
  const open = new Map<string, OpenPart>();
  let finish: Pick<GenerateResult, 'finishReason' | 'usage' | 'providerMetadata'> | undefined;
  let warnings: GenerateResult['warnings'] = [];
  let metadata: NonNullable<GenerateResult['response']> = {};
  let finished = false;

  // A part's metadata grows as it streams: the end event has the final item id
  // and the encrypted reasoning, so it replaces what the start event had.
  const begin = (type: OpenPart['type'], id: string, providerMetadata?: ProviderMetadata) => {
    const part: OpenPart = { type, text: '', providerMetadata };
    open.set(`${type}:${id}`, part);
    content.push(part as Content);
  };
  const append = (type: OpenPart['type'], id: string, delta: string) => {
    const part = open.get(`${type}:${id}`);
    if (part) part.text += delta;
  };
  const end = (type: OpenPart['type'], id: string, providerMetadata?: ProviderMetadata) => {
    const part = open.get(`${type}:${id}`);
    if (part && providerMetadata) part.providerMetadata = providerMetadata;
    open.delete(`${type}:${id}`);
  };

  for await (const part of stream) {
    switch (part.type) {
      case 'stream-start': warnings = part.warnings; break;
      case 'response-metadata': {
        const { type: _type, ...rest } = part;
        metadata = { ...metadata, ...rest };
        break;
      }
      case 'text-start': begin('text', part.id, part.providerMetadata); break;
      case 'text-delta': append('text', part.id, part.delta); break;
      case 'text-end': end('text', part.id, part.providerMetadata); break;
      case 'reasoning-start': begin('reasoning', part.id, part.providerMetadata); break;
      case 'reasoning-delta': append('reasoning', part.id, part.delta); break;
      case 'reasoning-end': end('reasoning', part.id, part.providerMetadata); break;
      case 'raw': finished ||= TERMINAL_EVENTS.has(eventType(part.rawValue)); break;
      // Tool input streams in pieces; the `tool-call` part that follows is whole.
      case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': break;
      case 'finish':
        finish = { finishReason: part.finishReason, usage: part.usage, providerMetadata: part.providerMetadata };
        break;
      case 'error': throw asCallError(part.error, url, request?.body, response?.headers);
      default: content.push(part); break;
    }
  }

  if (!finish || !finished) {
    throw new APICallError({
      message: 'The model stream closed before the response finished.',
      url,
      requestBodyValues: request?.body,
      responseHeaders: response?.headers,
      isRetryable: true,
    });
  }
  return {
    ...finish,
    content,
    warnings,
    request,
    response: { ...metadata, headers: response?.headers },
  };
}

function eventType(rawValue: unknown): string {
  const type = (rawValue as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : '';
}

// An error after output started arrives as a plain object. As an APICallError it
// keeps its status and retryability, so `generateText` retries it as it would
// a failed non-streaming call.
function asCallError(
  error: unknown,
  url: string,
  requestBodyValues: unknown,
  responseHeaders: Record<string, string> | undefined,
): unknown {
  if (error instanceof Error) return error;
  const fields = (error ?? {}) as { message?: unknown; statusCode?: unknown; isRetryable?: unknown };
  return new APICallError({
    message: typeof fields.message === 'string' ? fields.message : JSON.stringify(error),
    url,
    requestBodyValues,
    responseHeaders,
    statusCode: typeof fields.statusCode === 'number' ? fields.statusCode : undefined,
    isRetryable: fields.isRetryable === true,
    data: error,
  });
}

/** `url` names the endpoint in the errors a failed stream raises. */
export function streamOnly(url: string): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ model, params }) =>
      collectStream(await model.doStream({ ...params, includeRawChunks: true }), url),
  };
}
