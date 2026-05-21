/**
 * Memory Manager Service Tests
 *
 * Tests for the MemoryManagerService:
 * - Embedding-based vector search
 * - Write with embedding generation
 * - Category filtering and importance scoring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestAgentWorkspace, createTestMemoryEntry } from '../../test-utils/factories';

// Use vi.hoisted to create mocks that are available before vi.mock hoisting
const { mockPrisma, mockEmbeddingService } = vi.hoisted(() => ({
  mockPrisma: {
    memoryEntry: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
  },
  mockEmbeddingService: {
    generateEmbedding: vi.fn(),
    storeEmbedding: vi.fn(),
    generateAndStoreEmbedding: vi.fn(),
    searchByEmbedding: vi.fn(),
  },
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('../embedding.service', () => ({
  embeddingService: mockEmbeddingService,
}));

// Import after mocking
import { memoryManagerService } from '../memory-manager.service';

describe('Memory Manager Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbeddingService.generateEmbedding.mockResolvedValue(null);
    mockEmbeddingService.generateAndStoreEmbedding.mockResolvedValue(undefined);
  });

  describe('Scenario: Memory search — vector path', () => {
    it('should use vector search when embedding succeeds', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });
      const mockResults = [
        { id: 'e1', content: 'Mario enjoys humor', category: 'observation', importance: 5, createdAt: new Date() },
      ];

      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEmbeddingService.searchByEmbedding.mockResolvedValue(mockResults);

      const results = await memoryManagerService.search(userId, 'what do I enjoy?', { agentId: agent.id });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Mario enjoys humor');
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith(agent.id, 'what do I enjoy?');
      expect(mockEmbeddingService.searchByEmbedding).toHaveBeenCalledWith(
        agent.id,
        [0.1, 0.2, 0.3],
        expect.objectContaining({ similarityThreshold: 0.3 }),
      );
    });

    it('should return empty results when embedding generation fails', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockEmbeddingService.generateEmbedding.mockResolvedValue(null);

      const results = await memoryManagerService.search(userId, 'test query', { agentId: agent.id });

      expect(results).toEqual([]);
      expect(mockEmbeddingService.searchByEmbedding).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Memory search — empty query', () => {
    it('should return empty results for empty query', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      const results = await memoryManagerService.search(userId, '', { agentId: agent.id });

      expect(results).toEqual([]);
      expect(mockEmbeddingService.generateEmbedding).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Memory search — options', () => {
    it('should pass categories to vector search', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.1]);
      mockEmbeddingService.searchByEmbedding.mockResolvedValue([]);

      await memoryManagerService.search(userId, 'test', {
        categories: ['observation', 'decision'],
        agentId: agent.id,
      });

      expect(mockEmbeddingService.searchByEmbedding).toHaveBeenCalledWith(
        agent.id,
        [0.1],
        expect.objectContaining({
          categories: ['observation', 'decision'],
        }),
      );
    });

    it('should pass limit to vector search', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.1]);
      mockEmbeddingService.searchByEmbedding.mockResolvedValue([]);

      await memoryManagerService.search(userId, 'test', { limit: 5, agentId: agent.id });

      expect(mockEmbeddingService.searchByEmbedding).toHaveBeenCalledWith(
        agent.id,
        [0.1],
        expect.objectContaining({ limit: 5 }),
      );
    });
  });

  describe('Scenario: Memory write', () => {
    it('should create a memory entry and trigger embedding generation', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.create.mockImplementation(async ({ data }: any) => ({
        id: 'entry-new',
        ...data,
        createdAt: new Date(),
      }));

      const result = await memoryManagerService.write(userId, {
        content: 'Important observation from conversation',
        category: 'observation',
        importance: 7,
      }, { agentId: agent.id });

      expect(result).toBeDefined();
      expect(result.content).toBe('Important observation from conversation');
      expect(mockEmbeddingService.generateAndStoreEmbedding).toHaveBeenCalledWith(
        agent.id,
        'entry-new',
        'Important observation from conversation',
      );
    });

    it('should use default importance of 5', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.create.mockImplementation(async ({ data }: any) => ({
        id: 'entry-new',
        ...data,
        createdAt: new Date(),
      }));

      const result = await memoryManagerService.write(userId, {
        content: 'Some observation',
        category: 'observation',
      }, { agentId: agent.id });

      expect(result.importance).toBe(5);
    });
  });

  describe('Scenario: Memory delete', () => {
    it('should delete a single entry by ID', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.deleteMany.mockResolvedValue({ count: 1 });

      const result = await memoryManagerService.delete(userId, 'entry-123', agent.id);

      expect(result).toBe(true);
      expect(mockPrisma.memoryEntry.deleteMany).toHaveBeenCalledWith({
        where: {
          id: 'entry-123',
          agentId: agent.id,
        },
      });
    });

    it('should delete multiple entries', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.deleteMany.mockResolvedValue({ count: 3 });

      const result = await memoryManagerService.deleteMany(userId, ['e1', 'e2', 'e3'], { agentId: agent.id });

      expect(result).toBe(3);
    });

    it('should return false when entry not found', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.deleteMany.mockResolvedValue({ count: 0 });

      const result = await memoryManagerService.delete(userId, 'non-existent', agent.id);

      expect(result).toBe(false);
    });
  });

  describe('Scenario: Get by category', () => {
    it('should return entries for a specific category', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      const entries = [
        createTestMemoryEntry({ agentId: agent.id, category: 'decision', content: 'Decision 1' }),
        createTestMemoryEntry({ agentId: agent.id, category: 'decision', content: 'Decision 2' }),
      ];

      mockPrisma.memoryEntry.findMany.mockResolvedValue(entries);

      const results = await memoryManagerService.getByCategory(userId, 'decision', agent.id);

      expect(results).toHaveLength(2);
      expect(mockPrisma.memoryEntry.findMany).toHaveBeenCalledWith({
        where: { agentId: agent.id, category: 'decision' },
        orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
        take: 20,
      });
    });
  });

  describe('Scenario: Memory cleanup', () => {
    it('should delete old low-importance entries', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.deleteMany.mockResolvedValue({ count: 5 });

      const result = await memoryManagerService.cleanup(userId, agent.id, 30, 3);

      expect(result).toBe(5);
      expect(mockPrisma.memoryEntry.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          agentId: agent.id,
          importance: { lt: 3 },
        }),
      });
    });
  });

  describe('Scenario: Memory stats', () => {
    it('should return memory statistics', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.count.mockResolvedValue(10);
      mockPrisma.memoryEntry.groupBy.mockResolvedValue([
        { category: 'decision', _count: { id: 5 } },
        { category: 'observation', _count: { id: 3 } },
        { category: 'event', _count: { id: 2 } },
      ]);
      mockPrisma.memoryEntry.aggregate.mockResolvedValue({ _avg: { importance: 6.5 } });

      const stats = await memoryManagerService.getStats(userId, agent.id);

      expect(stats.totalEntries).toBe(10);
      expect(stats.byCategory).toEqual({
        decision: 5,
        observation: 3,
        event: 2,
      });
      expect(stats.avgImportance).toBe(6.5);
    });
  });

  describe('Scenario: Build memory context', () => {
    it('should return empty string when no entries exist', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.findMany.mockResolvedValue([]);

      const result = await memoryManagerService.buildMemoryContext(userId, agent.id);

      expect(result).toBe('');
    });

    it('should include high-importance entries grouped by category', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      const entries = [
        createTestMemoryEntry({ agentId: agent.id, category: 'decision', content: 'Use TypeScript', importance: 9 }),
        createTestMemoryEntry({ agentId: agent.id, category: 'observation', content: 'Cluster has 3 nodes', importance: 10 }),
        createTestMemoryEntry({ agentId: agent.id, category: 'decision', content: 'Deploy to us-east-1', importance: 9 }),
      ];

      mockPrisma.memoryEntry.findMany.mockResolvedValueOnce(entries);

      const result = await memoryManagerService.buildMemoryContext(userId, agent.id);

      expect(result).toContain('## Decisions');
      expect(result).toContain('Use TypeScript');
      expect(result).toContain('Deploy to us-east-1');
      expect(result).toContain('## Observations');
      expect(result).toContain('Cluster has 3 nodes');
    });

    it('should fetch important entries with importance >= 9', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      mockPrisma.memoryEntry.findMany.mockResolvedValueOnce([]);

      await memoryManagerService.buildMemoryContext(userId, agent.id);

      expect(mockPrisma.memoryEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: agent.id, importance: { gte: 9 } },
          orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
          take: 15,
        })
      );
    });

    it('should include query-relevant entries when query provided', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });
      const mockVector = [0.1, 0.2];

      // First call: importantEntries (none)
      mockPrisma.memoryEntry.findMany.mockResolvedValueOnce([]);
      // search() uses vector search
      mockEmbeddingService.generateEmbedding.mockResolvedValue(mockVector);
      mockEmbeddingService.searchByEmbedding.mockResolvedValue([
        { id: 'e1', content: 'OOM killed pod-xyz yesterday', category: 'observation', importance: 5, createdAt: new Date() },
      ]);

      const result = await memoryManagerService.buildMemoryContext(userId, agent.id, 'pod crashes');

      expect(result).toContain('## Relevant to Current Query');
      expect(result).toContain('OOM killed pod-xyz yesterday');
    });

    it('should deduplicate entries appearing in both important and relevant sets', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });
      const sharedId = 'shared-entry-id';

      const sharedEntry = createTestMemoryEntry({
        id: sharedId,
        agentId: agent.id,
        content: 'Important and relevant',
        importance: 10,
      });

      // Important query returns the shared entry
      mockPrisma.memoryEntry.findMany.mockResolvedValueOnce([sharedEntry]);
      // Vector search also returns the same entry
      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.1]);
      mockEmbeddingService.searchByEmbedding.mockResolvedValue([
        { id: sharedId, content: 'Important and relevant', category: 'decision', importance: 10, createdAt: new Date() },
      ]);

      const result = await memoryManagerService.buildMemoryContext(userId, agent.id, 'relevant query');

      // Content should appear once (in important section), NOT in "Relevant to Current Query"
      const occurrences = result.split('Important and relevant').length - 1;
      expect(occurrences).toBe(1);
      expect(result).not.toContain('## Relevant to Current Query');
    });

    it('should respect character budget', async () => {
      const userId = 'user-123';
      const agent = createTestAgentWorkspace({ userId });

      // Create entries with content that exceeds 4000 chars total
      const longContent = 'A'.repeat(500);
      const entries = Array.from({ length: 20 }, (_, i) =>
        createTestMemoryEntry({
          agentId: agent.id,
          content: `${longContent} entry ${i}`,
          category: 'observation',
          importance: 9,
        })
      );

      mockPrisma.memoryEntry.findMany.mockResolvedValueOnce(entries);

      const result = await memoryManagerService.buildMemoryContext(userId, agent.id);

      // Should not contain all 20 entries — budget should cut it off
      const lineCount = result.split('\n- ').length - 1;
      expect(lineCount).toBeLessThan(20);
      expect(lineCount).toBeGreaterThan(0);
    });
  });
});
