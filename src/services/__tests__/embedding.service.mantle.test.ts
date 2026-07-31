/**
 * Embedding service — bedrock-mantle provider branch.
 *
 * Separate file from embedding.service.test.ts for the same reason the Azure
 * one is: the provider-option key (openai vs bedrock) is resolved at module
 * load from config. Mantle serves no embeddings, so its provider reaches Titan
 * on bedrock-runtime — meaning this branch must stay on the `bedrock` key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmbed, mockEmbedMany, mockCreateProvider, mockEmbeddingFn, mockConfig } = vi.hoisted(
  () => {
    const mockEmbeddingFn = vi.fn().mockReturnValue('mock-titan-embedding-model');
    return {
      mockEmbed: vi.fn(),
      mockEmbedMany: vi.fn(),
      mockCreateProvider: vi.fn().mockReturnValue({ embedding: mockEmbeddingFn }),
      mockEmbeddingFn,
      mockConfig: {
        llmProvider: 'bedrock-mantle',
        embeddingModelId: 'amazon.titan-embed-text-v2:0',
      },
    };
  },
);

vi.mock('ai', () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock('../../lib/llm-providers/create-provider', () => ({
  createProvider: mockCreateProvider,
}));
vi.mock('../../config', () => ({ config: mockConfig }));

import { embeddingService } from '../embedding.service';

describe('EmbeddingService (bedrock-mantle)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.embeddingModelId = 'amazon.titan-embed-text-v2:0';
    mockCreateProvider.mockReturnValue({ embedding: mockEmbeddingFn });
    mockEmbeddingFn.mockReturnValue('mock-titan-embedding-model');
  });

  it('uses the bedrock provider-options key with 1024 dims (embeddings are Titan, not mantle)', async () => {
    const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mockEmbed.mockResolvedValue({ embedding: mockVector });

    const result = await embeddingService.generateEmbedding('agent-1', 'test content');

    expect(result).toEqual(mockVector);
    expect(mockEmbeddingFn).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { bedrock: { dimensions: 1024 } },
      }),
    );
  });

  it('batch path also uses the bedrock key', async () => {
    mockEmbedMany.mockResolvedValue({ embeddings: [[0.1], [0.2]] });

    await embeddingService.generateEmbeddings('agent-1', ['one', 'two']);

    expect(mockEmbedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { bedrock: { dimensions: 1024 } },
      }),
    );
  });

  it('skips the SDK call and returns null when embeddings are disabled', async () => {
    mockConfig.embeddingModelId = '';

    expect(await embeddingService.generateEmbedding('agent-1', 'text')).toBeNull();
    expect(await embeddingService.generateEmbeddings('agent-1', ['a'])).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});
