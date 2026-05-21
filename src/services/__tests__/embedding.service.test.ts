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

    it('should use direct Bedrock provider when no Nexus token is available', async () => {
      const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
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

    it('should use direct Bedrock provider for batched embeddings when no Nexus token is available', async () => {
      mockGetNexusMcpAgentToken.mockResolvedValue(null);
      mockEmbedMany.mockResolvedValue({ embeddings: [[0.1]] });

      const result = await embeddingService.generateEmbeddings('agent-1', ['one']);

      expect(result).toEqual([[0.1]]);
      expect(mockCreateBedrockProvider).toHaveBeenCalled();
      expect(mockEmbedMany).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'mock-direct-embedding-model' }),
      );
    });
  });

});
