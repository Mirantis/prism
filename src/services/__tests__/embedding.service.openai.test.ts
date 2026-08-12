/**
 * Embedding service — OpenAI provider branch.
 *
 * Separate file from embedding.service.test.ts because the provider-option
 * key (openai vs bedrock) is resolved at module load from config; this file's
 * config mock selects the OpenAI branch. Without the `openai` key the
 * dimensions option would be silently ignored and text-embedding-3 models
 * would return 1536-dim vectors the 1024-dim sqlite-vec index rejects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmbed, mockEmbedMany, mockCreateProvider, mockEmbeddingFn, mockConfig } = vi.hoisted(
  () => {
    const mockEmbeddingFn = vi.fn().mockReturnValue('mock-openai-embedding-model');
    return {
      mockEmbed: vi.fn(),
      mockEmbedMany: vi.fn(),
      mockCreateProvider: vi.fn().mockReturnValue({ embedding: mockEmbeddingFn }),
      mockEmbeddingFn,
      mockConfig: {
        llmProvider: 'openai',
        embeddingModelId: 'text-embedding-3-small',
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

describe('EmbeddingService (openai)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.embeddingModelId = 'text-embedding-3-small';
    mockCreateProvider.mockReturnValue({ embedding: mockEmbeddingFn });
    mockEmbeddingFn.mockReturnValue('mock-openai-embedding-model');
  });

  it('uses the openai provider-options key with 1024 dims (not bedrock)', async () => {
    const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mockEmbed.mockResolvedValue({ embedding: mockVector });

    const result = await embeddingService.generateEmbedding('agent-1', 'test content');

    expect(result).toEqual(mockVector);
    expect(mockEmbeddingFn).toHaveBeenCalledWith('text-embedding-3-small');
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { dimensions: 1024 } },
      }),
    );
  });

  it('batch path also uses the openai key', async () => {
    mockEmbedMany.mockResolvedValue({ embeddings: [[0.1], [0.2]] });

    await embeddingService.generateEmbeddings('agent-1', ['one', 'two']);

    expect(mockEmbedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { dimensions: 1024 } },
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
