/**
 * Serves a non-streaming call from the model's stream, for an endpoint that
 * answers only streamed requests. The parts are collected into the result the
 * call would have returned, so callers keep using `generateText`.
 */

import type { LanguageModelMiddleware } from 'ai';

type WrapGenerate = NonNullable<LanguageModelMiddleware['wrapGenerate']>;
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type StreamResult = Awaited<ReturnType<Parameters<WrapGenerate>[0]['doStream']>>;
type Content = GenerateResult['content'][number];
type ProviderMetadata = GenerateResult['providerMetadata'];

interface OpenPart {
  type: 'text' | 'reasoning';
  text: string;
  providerMetadata?: ProviderMetadata;
}

export async function collectStream({ stream, request, response }: StreamResult): Promise<GenerateResult> {
  const content: Content[] = [];
  const open = new Map<string, OpenPart>();
  let finish: Pick<GenerateResult, 'finishReason' | 'usage' | 'providerMetadata'> | undefined;
  let warnings: GenerateResult['warnings'] = [];
  let metadata: NonNullable<GenerateResult['response']> = {};

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
      // Tool input streams in pieces; the `tool-call` part that follows is whole.
      case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'raw': break;
      case 'finish':
        finish = { finishReason: part.finishReason, usage: part.usage, providerMetadata: part.providerMetadata };
        break;
      case 'error': throw part.error;
      default: content.push(part); break;
    }
  }

  if (!finish) throw new Error('The model stream ended without a finish event.');
  return {
    ...finish,
    content,
    warnings,
    request,
    response: { ...metadata, headers: response?.headers },
  };
}

export const STREAM_ONLY: LanguageModelMiddleware = {
  wrapGenerate: async ({ doStream }) => collectStream(await doStream()),
};
