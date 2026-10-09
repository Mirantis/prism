import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockMemoryManagerService, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspace: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockMemoryManagerService: {
    search: vi.fn(),
    write: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../services/memory-manager.service', () => ({
  memoryManagerService: mockMemoryManagerService,
}));

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

import { getMemoryTools } from '../memory';

const userId = 'user-123';
const agentId = 'test-agent-id';

/**
 * The lock is read live through agentWorkspaceService.isLockedIn(), which
 * resolves to the mocked prisma.findUnique, so `lockedIn` here drives the gate.
 */
function createTestAgentWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    userId,
    name: 'Prism',
    lockedIn: false,
    ...overrides,
  };
}

type ToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

interface MemoryResult {
  success: boolean;
  error?: string;
  count?: number;
  entryId?: string;
  deletedCount?: number;
}

describe('getMemoryTools', () => {
  let tools: Record<string, { execute: ToolExecute }>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspace.findUnique.mockResolvedValue(createTestAgentWorkspace());
    mockMemoryManagerService.search.mockResolvedValue([{ id: 'm1', content: 'a memory' }]);
    mockMemoryManagerService.write.mockResolvedValue({ id: 'entry-1' });
    mockMemoryManagerService.deleteMany.mockResolvedValue(2);
    tools = getMemoryTools(userId, agentId) as unknown as Record<
      string,
      { execute: ToolExecute }
    >;
  });

  it('exposes search, write and delete', () => {
    expect(Object.keys(tools)).toEqual(['memory_search', 'memory_write', 'memory_delete']);
  });

  it('memory_write stores the entry when unlocked', async () => {
    const result = (await tools.memory_write.execute({
      content: 'The staging region is eu-west-1',
      category: 'observation',
    })) as MemoryResult;

    expect(result.success).toBe(true);
    expect(result.entryId).toBe('entry-1');
    expect(mockMemoryManagerService.write).toHaveBeenCalledWith(
      userId,
      { content: 'The staging region is eu-west-1', category: 'observation', importance: undefined },
      { agentId },
    );
  });

  it('memory_delete removes the entries when unlocked', async () => {
    const result = (await tools.memory_delete.execute({ entryIds: ['a', 'b'] })) as MemoryResult;

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(2);
    expect(mockMemoryManagerService.deleteMany).toHaveBeenCalledWith(userId, ['a', 'b'], { agentId });
  });

  describe('memory_search', () => {
    const searchOptions = () => mockMemoryManagerService.search.mock.calls[0][2];

    it('searches the whole store when no window is given', async () => {
      await tools.memory_search.execute({ query: 'staging region' });

      expect(searchOptions()).toMatchObject({ since: undefined, until: undefined });
    });

    // "What did you record last Tuesday" is one date on both bounds.
    it('reads a bare date as that whole day in UTC', async () => {
      await tools.memory_search.execute({ query: 'deploys', since: '2026-10-06', until: '2026-10-06' });

      expect(searchOptions()).toMatchObject({
        since: new Date('2026-10-06T00:00:00.000Z'),
        until: new Date('2026-10-06T23:59:59.999Z'),
      });
    });

    it('takes a date-time with an offset as that instant', async () => {
      await tools.memory_search.execute({ since: '2026-10-06T14:30:00+03:00' });

      expect(searchOptions().since).toEqual(new Date('2026-10-06T11:30:00Z'));
    });

    it('lists the newest entries when there is no query', async () => {
      await tools.memory_search.execute({ limit: 5 });

      expect(mockMemoryManagerService.search).toHaveBeenCalledWith(userId, undefined, expect.objectContaining({ limit: 5 }));
    });

    it('passes the order on', async () => {
      await tools.memory_search.execute({ query: 'deploys', sort: 'newest' });

      expect(searchOptions().sort).toBe('newest');
    });

    // A date the parser would roll over (February 30th) or read in the host's zone
    // (no offset) is refused rather than searched.
    it.each([
      ['since', 'last tuesday'],
      ['since', '2026-02-30'],
      ['until', '2026-10-06T14:30:00'],
      ['until', 'Oct 6'],
    ])('refuses a malformed %s of %j and names it', async (bound, value) => {
      const result = (await tools.memory_search.execute({ query: 'x', [bound]: value })) as MemoryResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain(`${bound} is not a date or a date-time: "${value}"`);
      expect(mockMemoryManagerService.search).not.toHaveBeenCalled();
    });

    it('refuses a window that starts after it ends', async () => {
      const result = (await tools.memory_search.execute({
        query: 'x',
        since: '2026-10-07',
        until: '2026-10-06',
      })) as MemoryResult;

      expect(result).toEqual({ success: false, error: 'since (2026-10-07) is after until (2026-10-06).' });
      expect(mockMemoryManagerService.search).not.toHaveBeenCalled();
    });

    it('reports the search shape and the result count, without the query', async () => {
      await tools.memory_search.execute({ query: 'deploys', until: '2026-10-06', sort: 'newest' });

      expect(mockTrackEvent).toHaveBeenCalledExactlyOnceWith('memory searched', userId, {
        'agent.id': agentId,
        'memory.search.has_query': 'true',
        'memory.search.has_window': 'true',
        'memory.search.sort': 'newest',
        'memory.search.status': 'ok',
        'memory.search.result_count': '1',
      });
    });

    it('reports a refused window', async () => {
      await tools.memory_search.execute({ since: 'last tuesday' });

      expect(mockTrackEvent).toHaveBeenCalledExactlyOnceWith('memory searched', userId, {
        'agent.id': agentId,
        'memory.search.has_query': 'false',
        'memory.search.has_window': 'true',
        'memory.search.sort': 'relevance',
        'memory.search.status': 'invalid_window',
      });
    });
  });

  // ==========================================================================
  // Locked-in mode
  // ==========================================================================

  describe('locked-in mode', () => {
    // Both writers, with an input that would otherwise succeed.
    const guarded: Array<[string, Record<string, unknown>]> = [
      ['memory_write', { content: 'remember this', category: 'observation', importance: 8 }],
      ['memory_delete', { entryIds: ['entry-1', 'entry-2'], reason: 'stale' }],
    ];

    beforeEach(() => {
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(
        createTestAgentWorkspace({ lockedIn: true }),
      );
    });

    it.each(guarded)('%s refuses and performs no write while locked', async (name, input) => {
      const result = (await tools[name].execute(input)) as MemoryResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Locked-in mode is on');
      expect(result.error).toContain('turn locked-in mode off');
      expect(mockMemoryManagerService.write).not.toHaveBeenCalled();
      expect(mockMemoryManagerService.deleteMany).not.toHaveBeenCalled();
    });

    // The refusal reaches the model, so it must describe long-term memory rather
    // than the workspace files.
    it.each(guarded)('%s refusal talks about memory, not workspace files', async (name, input) => {
      const result = (await tools[name].execute(input)) as MemoryResult;

      expect(result.error).toContain('long-term memory is read-only');
      expect(result.error).not.toContain('workspace files');
    });

    it.each(guarded)('%s records the refusal as telemetry exactly once', async (name, input) => {
      await tools[name].execute(input);

      const refusals = mockTrackEvent.mock.calls.filter((c) => c[0] === 'agent locked write refused');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toEqual([
        'agent locked write refused',
        null,
        { 'agent.id': agentId, 'config.field': 'memoryEntry' },
      ]);
    });

    it('still searches memory while locked', async () => {
      const result = (await tools.memory_search.execute({ query: 'staging region' })) as MemoryResult;

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(mockMemoryManagerService.search).toHaveBeenCalledWith(userId, 'staging region', {
        categories: undefined,
        limit: 25,
        since: undefined,
        until: undefined,
        sort: undefined,
        agentId,
      });
    });

    it('resumes writing once the lock is lifted', async () => {
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(
        createTestAgentWorkspace({ lockedIn: false }),
      );

      const write = (await tools.memory_write.execute({
        content: 'remember this',
        category: 'decision',
      })) as MemoryResult;
      const del = (await tools.memory_delete.execute({ entryIds: ['entry-1'] })) as MemoryResult;

      expect(write.success).toBe(true);
      expect(del.success).toBe(true);
      expect(mockMemoryManagerService.write).toHaveBeenCalledTimes(1);
      expect(mockMemoryManagerService.deleteMany).toHaveBeenCalledTimes(1);
    });
  });
});
