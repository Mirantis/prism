/**
 * Which provider-option key carries the embedding dimension.
 *
 * Worth its own test because getting it wrong fails *silently*: the AI SDK
 * ignores provider options addressed to a provider that is not serving the call,
 * so the model returns its native dimensionality and the only symptom is vectors
 * the sqlite-vec index (fixed at 1024) cannot hold. Nothing throws at
 * configuration time, and no other test would notice.
 *
 * The rule is not "which vendor" but "which SDK".
 */
import { describe, it, expect } from 'vitest';
import { embeddingProviderOptions } from './embedding.service';

describe('embeddingProviderOptions', () => {
  it.each(['azure', 'openai', 'openrouter'])(
    'addresses the dimension to `openai` for %s, which the OpenAI SDK serves',
    (provider) => {
      // openrouter rides the OpenAI provider code, so it belongs here even
      // though it is a different vendor.
      expect(embeddingProviderOptions(provider)).toEqual({ openai: { dimensions: 1024 } });
    },
  );

  it.each(['bedrock', 'bedrock-mantle'])(
    'addresses the dimension to `bedrock` for %s, whose embeddings are Titan',
    (provider) => {
      // bedrock-mantle has no embedding surface of its own — those calls go to
      // Titan on bedrock-runtime, so it belongs on this arm despite being a
      // separate provider everywhere else.
      expect(embeddingProviderOptions(provider)).toEqual({ bedrock: { dimensions: 1024 } });
    },
  );

  it('falls back to the Titan shape for an unknown provider', () => {
    // Matches how the rest of the runtime treats an unrecognized provider: it
    // resolves to bedrock, so the embedding options must agree rather than
    // address a provider that is not serving the call.
    expect(embeddingProviderOptions('some-future-vendor')).toEqual({
      bedrock: { dimensions: 1024 },
    });
  });

  it('asks for the dimension the vector index is built for', () => {
    // 1024 is EMBEDDING_DIM in sqlite-bootstrap.ts, where the index is declared.
    // Changing one without the other produces vectors the index cannot hold.
    expect(Object.values(embeddingProviderOptions('openrouter'))[0]).toEqual({ dimensions: 1024 });
  });
});
