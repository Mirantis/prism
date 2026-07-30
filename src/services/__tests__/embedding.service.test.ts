import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEmbed,
  mockEmbedMany,
  mockPrisma,
  mockCreateBedrockProvider,
  mockDirectEmbeddingFn,
  mockConfig,
} = vi.hoisted(() => {
  const mockDirectEmbeddingFn = vi.fn().mockReturnValue('mock-direct-embedding-model');
  return {
    mockEmbed: vi.fn(),
    mockEmbedMany: vi.fn(),
    mockPrisma: {
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
    mockCreateBedrockProvider: vi.fn().mockReturnValue({ embedding: mockDirectEmbeddingFn }),
    mockDirectEmbeddingFn,
    mockConfig: {
      llmProvider: 'bedrock',
      embeddingModelId: 'amazon.titan-embed-text-v2:0',
    },
  };
});

vi.mock('ai', () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/llm-providers/bedrock/bedrock-provider', () => ({
  createBedrockProvider: mockCreateBedrockProvider,
}));
vi.mock('../../config', () => ({ config: mockConfig }));

import { embeddingService } from '../embedding.service';

describe('EmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateBedrockProvider.mockReturnValue({ embedding: mockDirectEmbeddingFn });
    mockDirectEmbeddingFn.mockReturnValue('mock-direct-embedding-model');
  });

  describe('generateEmbedding', () => {
    it('should generate embedding via the direct Bedrock provider', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      mockEmbed.mockResolvedValue({ embedding: mockVector });

      const result = await embeddingService.generateEmbedding('agent-1', 'test content');

      expect(result).toEqual(mockVector);
      expect(mockCreateBedrockProvider).toHaveBeenCalled();
      expect(mockDirectEmbeddingFn).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-direct-embedding-model',
          value: 'test content',
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });

    it('should return null on error', async () => {
      mockEmbed.mockRejectedValue(new Error('Bedrock timeout'));

      const result = await embeddingService.generateEmbedding('agent-1', 'test');

      expect(result).toBeNull();
    });
  });

  describe('generateEmbeddings', () => {
    it('should generate batched embeddings with 1024 dimensions', async () => {
      const mockVectors = [
        Array.from({ length: 1024 }, (_, i) => i * 0.001),
        Array.from({ length: 1024 }, (_, i) => i * 0.002),
      ];
      mockEmbedMany.mockResolvedValue({ embeddings: mockVectors });

      const result = await embeddingService.generateEmbeddings('agent-1', ['one', 'two']);

      expect(result).toEqual(mockVectors);
      expect(mockCreateBedrockProvider).toHaveBeenCalled();
      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-direct-embedding-model',
          values: ['one', 'two'],
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });
  });

});
