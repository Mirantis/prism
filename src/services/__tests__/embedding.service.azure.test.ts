/**
 * Embedding service — Azure provider branch.
 *
 * Separate file from embedding.service.test.ts because the provider-option
 * key (openai vs bedrock) is resolved at module load from config; this file's
 * config mock selects the Azure branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmbed, mockEmbedMany, mockCreateAzureProvider, mockEmbeddingFn, mockConfig } =
  vi.hoisted(() => {
    const mockEmbeddingFn = vi.fn().mockReturnValue('mock-azure-embedding-model');
    return {
      mockEmbed: vi.fn(),
      mockEmbedMany: vi.fn(),
      mockCreateAzureProvider: vi.fn().mockReturnValue({ embedding: mockEmbeddingFn }),
      mockEmbeddingFn,
      mockConfig: {
        llmProvider: 'azure',
        embeddingModelId: 'text-embed-3-deployment',
      },
    };
  });

vi.mock('ai', () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock('../../lib/llm-providers/create-provider', () => ({
  createProvider: mockCreateAzureProvider,
}));
vi.mock('../../config', () => ({ config: mockConfig }));

import { embeddingService } from '../embedding.service';

describe('EmbeddingService (azure)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.embeddingModelId = 'text-embed-3-deployment';
    mockCreateAzureProvider.mockReturnValue({ embedding: mockEmbeddingFn });
    mockEmbeddingFn.mockReturnValue('mock-azure-embedding-model');
  });

  it('uses the openai provider-options key with 1024 dims (not bedrock)', async () => {
    const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mockEmbed.mockResolvedValue({ embedding: mockVector });

    const result = await embeddingService.generateEmbedding('agent-1', 'test content');

    expect(result).toEqual(mockVector);
    expect(mockEmbeddingFn).toHaveBeenCalledWith('text-embed-3-deployment');
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

  it('skips the SDK call and returns null when no embedding deployment is configured', async () => {
    mockConfig.embeddingModelId = '';

    expect(await embeddingService.generateEmbedding('agent-1', 'text')).toBeNull();
    expect(await embeddingService.generateEmbeddings('agent-1', ['a'])).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});
