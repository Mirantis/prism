import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrisma, mockEmbeddingService } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $disconnect: vi.fn(),
  },
  mockEmbeddingService: {
    generateEmbeddings: vi.fn(),
    storeEmbedding: vi.fn(),
  },
}));

vi.mock('../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../services/embedding.service', () => ({ embeddingService: mockEmbeddingService }));

import { runBackfill } from './backfill-embeddings';

describe('backfill-embeddings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.$queryRawUnsafe.mockReset();
    mockPrisma.$executeRawUnsafe.mockReset();
    mockEmbeddingService.generateEmbeddings.mockReset();
    mockEmbeddingService.storeEmbedding.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backfills missing embeddings through the provider-aware embedding store', async () => {
    const entries = [
      { id: 'entry-1', agentId: 'agent-1', content: 'first memory' },
      { id: 'entry-2', agentId: 'agent-1', content: 'second memory' },
    ];
    const e1 = Array.from({ length: 1024 }, () => 0.1);
    const e2 = Array.from({ length: 1024 }, () => 0.2);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(entries).mockResolvedValueOnce([]);
    // BATCH_SIZE=1 — backfill calls generateEmbeddings once per entry (the
    // rate-limit safety from main: serial single-entry calls + 1s pause).
    mockEmbeddingService.generateEmbeddings
      .mockResolvedValueOnce([e1])
      .mockResolvedValueOnce([e2]);
    mockEmbeddingService.storeEmbedding.mockResolvedValue(undefined);

    const result = await runBackfill();

    expect(result).toEqual({ processed: 2, failed: 0, scanned: 2 });
    expect(mockEmbeddingService.generateEmbeddings).toHaveBeenCalledTimes(2);
    expect(mockEmbeddingService.generateEmbeddings).toHaveBeenNthCalledWith(1, 'agent-1', ['first memory']);
    expect(mockEmbeddingService.generateEmbeddings).toHaveBeenNthCalledWith(2, 'agent-1', ['second memory']);
    expect(mockEmbeddingService.storeEmbedding).toHaveBeenNthCalledWith(1, 'entry-1', e1);
    expect(mockEmbeddingService.storeEmbedding).toHaveBeenNthCalledWith(2, 'entry-2', e2);
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('counts generation failure for a batch and continues without throwing', async () => {
    const entries = [{ id: 'entry-1', agentId: 'agent-1', content: 'first memory' }];
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(entries).mockResolvedValueOnce([]);
    mockEmbeddingService.generateEmbeddings.mockResolvedValue(null);

    const result = await runBackfill();

    expect(result).toEqual({ processed: 0, failed: 1, scanned: 1 });
    expect(mockEmbeddingService.storeEmbedding).not.toHaveBeenCalled();
  });

  it('logs per-entry store failures and keeps processing other entries', async () => {
    const entries = [
      { id: 'entry-1', agentId: 'agent-1', content: 'first memory' },
      { id: 'entry-2', agentId: 'agent-1', content: 'second memory' },
    ];
    const e1 = Array.from({ length: 1024 }, () => 0.1);
    const e2 = Array.from({ length: 1024 }, () => 0.2);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(entries).mockResolvedValueOnce([]);
    mockEmbeddingService.generateEmbeddings
      .mockResolvedValueOnce([e1])
      .mockResolvedValueOnce([e2]);
    mockEmbeddingService.storeEmbedding
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('write failed'));

    const result = await runBackfill();

    expect(result).toEqual({ processed: 1, failed: 1, scanned: 2 });
    expect(mockEmbeddingService.storeEmbedding).toHaveBeenCalledTimes(2);
  });

  it('skips a batch when the embedding count does not match', async () => {
    // With BATCH_SIZE=1, "count mismatch" means the model returned ≠ 1
    // embedding for a single-text batch. Simulate by returning an empty array.
    const entries = [{ id: 'entry-1', agentId: 'agent-1', content: 'first memory' }];
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(entries).mockResolvedValueOnce([]);
    mockEmbeddingService.generateEmbeddings.mockResolvedValue([]);

    const result = await runBackfill();

    expect(result).toEqual({ processed: 0, failed: 1, scanned: 1 });
    expect(mockEmbeddingService.storeEmbedding).not.toHaveBeenCalled();
  });
});
