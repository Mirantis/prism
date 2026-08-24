/**
 * Embedding service — provider-agnostic.
 *
 * The service takes whatever `createEmbeddingProvider()` returns and forwards
 * its model and providerOptions fragment verbatim — asserted here with both a
 * bedrock-shaped and an openai-shaped fragment, so the service can't quietly
 * hardcode either. Per-vendor fragment correctness lives in each embedding
 * provider's own spec (`lib/embedding-providers/*.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmbed, mockEmbedMany, mockPrisma, mockCreateEmbeddingProvider, mockModelFn, mockConfig } =
  vi.hoisted(() => {
    const mockModelFn = vi.fn().mockReturnValue('mock-embedding-model');
    return {
      mockEmbed: vi.fn(),
      mockEmbedMany: vi.fn(),
      mockPrisma: {
        $executeRaw: vi.fn(),
        $queryRawUnsafe: vi.fn(),
      },
      mockCreateEmbeddingProvider: vi.fn(),
      mockModelFn,
      mockConfig: {
        embeddingModelId: 'amazon.titan-embed-text-v2:0',
      },
    };
  });

vi.mock('ai', () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/embedding-providers/create-embedding-provider', () => ({
  createEmbeddingProvider: mockCreateEmbeddingProvider,
}));
vi.mock('../../config', () => ({ config: mockConfig }));

import { embeddingService } from '../embedding.service';

const bedrockShapedProvider = {
  model: mockModelFn,
  providerOptions: { bedrock: { dimensions: 1024 } },
};
const openaiShapedProvider = {
  model: mockModelFn,
  providerOptions: { openai: { dimensions: 1024 } },
};

describe('EmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.embeddingModelId = 'amazon.titan-embed-text-v2:0';
    mockCreateEmbeddingProvider.mockReturnValue(bedrockShapedProvider);
    mockModelFn.mockReturnValue('mock-embedding-model');
  });

  describe('generateEmbedding', () => {
    it('forwards the model id and the provider fragment verbatim', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      mockEmbed.mockResolvedValue({ embedding: mockVector });

      const result = await embeddingService.generateEmbedding('agent-1', 'test content');

      expect(result).toEqual(mockVector);
      expect(mockModelFn).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-embedding-model',
          value: 'test content',
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });

    it('forwards an openai-shaped fragment just as verbatim', async () => {
      mockCreateEmbeddingProvider.mockReturnValue(openaiShapedProvider);
      mockConfig.embeddingModelId = 'text-embedding-3-small';
      mockEmbed.mockResolvedValue({ embedding: [0.1] });

      await embeddingService.generateEmbedding('agent-1', 'test content');

      expect(mockModelFn).toHaveBeenCalledWith('text-embedding-3-small');
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: { openai: { dimensions: 1024 } },
        }),
      );
    });

    it('returns null on error', async () => {
      mockEmbed.mockRejectedValue(new Error('Bedrock timeout'));

      expect(await embeddingService.generateEmbedding('agent-1', 'test')).toBeNull();
    });

    it('skips the SDK call and returns null when embeddings are disabled', async () => {
      mockConfig.embeddingModelId = '';

      expect(await embeddingService.generateEmbedding('agent-1', 'text')).toBeNull();
      expect(mockCreateEmbeddingProvider).not.toHaveBeenCalled();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns null when no embedding provider is configured', async () => {
      mockCreateEmbeddingProvider.mockReturnValue(null);

      expect(await embeddingService.generateEmbedding('agent-1', 'text')).toBeNull();
      expect(mockEmbed).not.toHaveBeenCalled();
    });
  });

  describe('generateEmbeddings', () => {
    it('forwards batch values, serialized, with the provider fragment', async () => {
      const mockVectors = [
        Array.from({ length: 1024 }, (_, i) => i * 0.001),
        Array.from({ length: 1024 }, (_, i) => i * 0.002),
      ];
      mockEmbedMany.mockResolvedValue({ embeddings: mockVectors });

      const result = await embeddingService.generateEmbeddings('agent-1', ['one', 'two']);

      expect(result).toEqual(mockVectors);
      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-embedding-model',
          values: ['one', 'two'],
          maxParallelCalls: 1,
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });

    it('returns [] for an empty batch without touching the provider or SDK', async () => {
      expect(await embeddingService.generateEmbeddings('agent-1', [])).toEqual([]);
      expect(mockCreateEmbeddingProvider).not.toHaveBeenCalled();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });

    it('returns null on error', async () => {
      mockEmbedMany.mockRejectedValue(new Error('throttled'));

      expect(await embeddingService.generateEmbeddings('agent-1', ['a'])).toBeNull();
    });

    it('skips the SDK call and returns null when embeddings are disabled', async () => {
      mockConfig.embeddingModelId = '';

      expect(await embeddingService.generateEmbeddings('agent-1', ['a'])).toBeNull();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });

    it('returns null when no embedding provider is configured', async () => {
      mockCreateEmbeddingProvider.mockReturnValue(null);

      expect(await embeddingService.generateEmbeddings('agent-1', ['a'])).toBeNull();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });
  });
});
