import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEmbed,
  mockEmbedMany,
  mockPrisma,
  mockGetNexusMcpAgentToken,
  mockCreateNexusProvider,
  mockCreateBedrockProvider,
  mockNexusEmbeddingFn,
  mockDirectEmbeddingFn,
  mockConfig,
} = vi.hoisted(() => {
  const mockNexusEmbeddingFn = vi.fn().mockReturnValue('mock-nexus-embedding-model');
  const mockDirectEmbeddingFn = vi.fn().mockReturnValue('mock-direct-embedding-model');
  return {
    mockEmbed: vi.fn(),
    mockEmbedMany: vi.fn(),
    mockPrisma: {
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
    mockGetNexusMcpAgentToken: vi.fn(),
    mockCreateNexusProvider: vi.fn().mockReturnValue({ embedding: mockNexusEmbeddingFn }),
    mockCreateBedrockProvider: vi.fn().mockReturnValue({ embedding: mockDirectEmbeddingFn }),
    mockNexusEmbeddingFn,
    mockDirectEmbeddingFn,
    mockConfig: {
      nexusLlmBaseUrl: 'http://localhost:3002/v1/llm/bedrock/us-east-1',
      bedrockEmbeddingModelId: 'amazon.titan-embed-text-v2:0',
      singleAgentMode: false,
    },
  };
});

vi.mock('ai', () => ({ embed: mockEmbed, embedMany: mockEmbedMany }));
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../agent-workspace.service', () => ({
  agentWorkspaceService: { getNexusMcpAgentToken: mockGetNexusMcpAgentToken },
}));
vi.mock('../../lib/nexus-provider', () => ({
  createNexusProvider: mockCreateNexusProvider,
}));
vi.mock('../../lib/bedrock-provider', () => ({
  createBedrockProvider: mockCreateBedrockProvider,
}));
vi.mock('../../config', () => ({ config: mockConfig }));

import { embeddingService } from '../embedding.service';

describe('EmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.singleAgentMode = false;
    mockConfig.nexusLlmBaseUrl = 'http://localhost:3002/v1/llm/bedrock/us-east-1';
    mockGetNexusMcpAgentToken.mockResolvedValue('nexus-token-123');
    mockCreateNexusProvider.mockReturnValue({ embedding: mockNexusEmbeddingFn });
    mockCreateBedrockProvider.mockReturnValue({ embedding: mockDirectEmbeddingFn });
    mockNexusEmbeddingFn.mockReturnValue('mock-nexus-embedding-model');
    mockDirectEmbeddingFn.mockReturnValue('mock-direct-embedding-model');
  });

  describe('generateEmbedding', () => {
    it('should generate embedding and return vector through Nexus when token exists', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      mockEmbed.mockResolvedValue({ embedding: mockVector });

      const result = await embeddingService.generateEmbedding('agent-1', 'test content');

      expect(result).toEqual(mockVector);
      expect(mockCreateNexusProvider).toHaveBeenCalledWith(
        'http://localhost:3002/v1/llm/bedrock/us-east-1',
        'nexus-token-123',
      );
      expect(mockEmbed).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-nexus-embedding-model',
          value: 'test content',
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });

    it('should use direct Bedrock provider in single-agent mode without a Nexus token', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      mockConfig.singleAgentMode = true;
      mockGetNexusMcpAgentToken.mockResolvedValue(null);
      mockEmbed.mockResolvedValue({ embedding: mockVector });

      const result = await embeddingService.generateEmbedding('agent-1', 'test content');

      expect(result).toEqual(mockVector);
      expect(mockCreateNexusProvider).not.toHaveBeenCalled();
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

    it('should return null when no agent token in multi-tenant mode', async () => {
      mockGetNexusMcpAgentToken.mockResolvedValue(null);

      const result = await embeddingService.generateEmbedding('agent-1', 'test');

      expect(result).toBeNull();
      expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
      expect(mockEmbed).not.toHaveBeenCalled();
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
      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mock-nexus-embedding-model',
          values: ['one', 'two'],
          providerOptions: { bedrock: { dimensions: 1024 } },
        }),
      );
    });

    it('should use direct Bedrock provider for batched embeddings in single-agent mode', async () => {
      mockConfig.singleAgentMode = true;
      mockGetNexusMcpAgentToken.mockResolvedValue(null);
      mockEmbedMany.mockResolvedValue({ embeddings: [[0.1]] });

      const result = await embeddingService.generateEmbeddings('agent-1', ['one']);

      expect(result).toEqual([[0.1]]);
      expect(mockCreateBedrockProvider).toHaveBeenCalled();
      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'mock-direct-embedding-model' }),
      );
    });

    it('should return null for batched embeddings when no model is available', async () => {
      mockGetNexusMcpAgentToken.mockResolvedValue(null);

      const result = await embeddingService.generateEmbeddings('agent-1', ['one']);

      expect(result).toBeNull();
      expect(mockEmbedMany).not.toHaveBeenCalled();
    });
  });

  describe('storeEmbedding', () => {
    it('should execute raw SQL to store vector', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);
      const vector = Array.from({ length: 1024 }, (_, i) => i * 0.001);

      await embeddingService.storeEmbedding('entry-1', vector);

      // $executeRaw is called with a tagged template; vitest receives a Prisma Sql object
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('should reject embedding with wrong dimensionality', async () => {
      await expect(
        embeddingService.storeEmbedding('entry-1', [0.1, 0.2, 0.3]),
      ).rejects.toThrow('Embedding dimensionality mismatch: expected 1024, got 3');
    });
  });

  describe('generateAndStoreEmbedding', () => {
    it('should generate embedding and store it', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
      mockEmbed.mockResolvedValue({ embedding: mockVector });
      mockPrisma.$executeRaw.mockResolvedValue(1);

      await embeddingService.generateAndStoreEmbedding('agent-1', 'entry-1', 'test content');

      expect(mockEmbed).toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('should skip store when embedding generation fails', async () => {
      mockEmbed.mockRejectedValue(new Error('fail'));

      await embeddingService.generateAndStoreEmbedding('agent-1', 'entry-1', 'test');

      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('searchByEmbedding', () => {
    const validVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);

    it('should execute cosine similarity query', async () => {
      const mockRows = [
        { id: 'e1', content: 'memory 1', category: 'observation', importance: 5, createdAt: new Date() },
      ];
      mockPrisma.$queryRawUnsafe.mockResolvedValue(mockRows);

      const cutoffDate = new Date('2025-01-01');
      const result = await embeddingService.searchByEmbedding('agent-1', validVector, {
        limit: 10,
        cutoffDate,
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('memory 1');
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('embedding'),
        'agent-1',
        cutoffDate,
        expect.stringContaining('[0,0.001,'),
        0.3,
        10,
      );
    });

    it('should include category filter when categories provided', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await embeddingService.searchByEmbedding('agent-1', validVector, {
        limit: 5,
        cutoffDate: new Date(),
        categories: ['observation', 'decision'],
      });

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ANY'),
        'agent-1',
        expect.any(Date),
        expect.stringContaining('[0,0.001,'),
        0.3,
        5,
        ['observation', 'decision'],
      );
    });

    it('should return empty array when no results', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await embeddingService.searchByEmbedding('agent-1', validVector, {
        limit: 10,
        cutoffDate: new Date(),
      });

      expect(result).toEqual([]);
    });

    it('should return empty array for wrong dimensionality', async () => {
      const result = await embeddingService.searchByEmbedding('agent-1', [0.1, 0.2], {
        limit: 10,
        cutoffDate: new Date(),
      });

      expect(result).toEqual([]);
      expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
