/**
 * Document Revision Service Tests
 *
 * The revision row itself: the content hash, the reason cap, the retention
 * delete that runs in the caller's transaction, the boot baseline, and the
 * history read with its drift verdict.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockTrackEvent, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspaceRevision: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

vi.mock('../../logger', () => ({ logger: mockLogger }));

import {
  documentDrift,
  documentHash,
  documentRevisionService,
  MAX_REVISIONS_PER_DOCUMENT,
  SEED_REASON,
  UPGRADE_REASON,
} from '../document-revision.service';
import { WORKSPACE_DOC_FIELDS, WorkspaceDocField } from '../../lib/workspace-docs';
import { AgentWorkspace } from '@prisma/client';

const agentId = 'agent-1';

/** The transaction client `record` is given. The same mock, so calls are visible. */
const tx = mockPrisma as unknown as Parameters<typeof documentRevisionService.record>[0];

function createAgentRow(overrides: Record<string, unknown> = {}): AgentWorkspace {
  const documents = Object.fromEntries(
    WORKSPACE_DOC_FIELDS.map((field) => [field, `# ${field}`]),
  );
  return { id: agentId, userId: 'user-1', ...documents, ...overrides } as unknown as AgentWorkspace;
}

describe('documentHash', () => {
  it('is the sha256 of the content, so equal documents hash equally', () => {
    expect(documentHash('# Soul')).toBe(documentHash('# Soul'));
    expect(documentHash('# Soul')).not.toBe(documentHash('# Soul '));
    expect(documentHash('')).toHaveLength(64);
  });
});

describe('documentRevisionService.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspaceRevision.create.mockResolvedValue({ id: 'rev-1' });
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
  });

  it('stores the content, its hash, and the actor and method it was given', async () => {
    await documentRevisionService.record(tx, {
      agentId,
      field: 'soulMd',
      content: '# Soul',
      actor: 'agent',
      method: 'replace',
      reason: 'Rewrote the tone.',
    });

    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: {
        agentId,
        field: 'soulMd',
        content: '# Soul',
        contentHash: documentHash('# Soul'),
        actor: 'agent',
        method: 'replace',
        reason: 'Rewrote the tone.',
      },
    });
  });

  it('caps a long reason instead of refusing the write', async () => {
    await documentRevisionService.record(tx, {
      agentId,
      field: 'soulMd',
      content: '# Soul',
      actor: 'agent',
      method: 'replace',
      reason: 'x'.repeat(900),
    });

    const { reason } = mockPrisma.agentWorkspaceRevision.create.mock.calls[0][0].data;
    expect(reason).toBe('x'.repeat(500));
  });

  it('deletes nothing while the document is inside the bound', async () => {
    await documentRevisionService.record(tx, {
      agentId,
      field: 'soulMd',
      content: '# Soul',
      actor: 'agent',
      method: 'replace',
      reason: 'Rewrote the tone.',
    });

    expect(mockPrisma.agentWorkspaceRevision.findMany).toHaveBeenCalledWith({
      where: { agentId, field: 'soulMd' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: MAX_REVISIONS_PER_DOCUMENT,
      select: { id: true },
    });
    expect(mockPrisma.agentWorkspaceRevision.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes what sits past the bound, in the caller transaction', async () => {
    // The read past the bound answers the oldest revision, which is what the
    // insert of the 501st pushes out.
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([{ id: 'oldest' }]);

    await documentRevisionService.record(tx, {
      agentId,
      field: 'memoryMd',
      content: '# Memory',
      actor: 'agent',
      method: 'edit',
      reason: 'Noted a preference.',
    });

    expect(mockPrisma.agentWorkspaceRevision.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['oldest'] } },
    });
  });

  it('bounds each document on its own', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);

    await documentRevisionService.record(tx, {
      agentId,
      field: 'memoryMd',
      content: '# Memory',
      actor: 'agent',
      method: 'edit',
      reason: 'Noted a preference.',
    });

    expect(mockPrisma.agentWorkspaceRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId, field: 'memoryMd' } }),
    );
  });
});

describe('documentRevisionService.recordSeeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspaceRevision.createMany.mockResolvedValue({ count: 7 });
  });

  it('records every document of a new agent in one insert', async () => {
    const agent = createAgentRow();

    await documentRevisionService.recordSeeds(tx, agent);

    expect(mockPrisma.agentWorkspaceRevision.createMany).toHaveBeenCalledTimes(1);
    const { data } = mockPrisma.agentWorkspaceRevision.createMany.mock.calls[0][0];
    expect(data.map((row: Record<string, unknown>) => row.field)).toEqual([
      ...WORKSPACE_DOC_FIELDS,
    ]);
    for (const row of data as Array<Record<string, unknown>>) {
      const field = row.field as WorkspaceDocField;
      expect(row.content).toBe(agent[field]);
      expect(row.contentHash).toBe(documentHash(agent[field]));
      expect(row.actor).toBe('user');
      expect(row.method).toBe('seed');
      expect(row.reason).toBe(SEED_REASON);
    }
  });

  it('runs no retention pass, since each document is gaining its first revision', async () => {
    await documentRevisionService.recordSeeds(tx, createAgentRow());

    expect(mockPrisma.agentWorkspaceRevision.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.agentWorkspaceRevision.deleteMany).not.toHaveBeenCalled();
  });
});

describe('documentRevisionService.recordMissingBaselines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspaceRevision.createMany.mockResolvedValue({ count: 0 });
  });

  it('records every document of an agent whose history is empty', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
    const agent = createAgentRow();

    const recorded = await documentRevisionService.recordMissingBaselines(agent);

    expect(recorded).toEqual([...WORKSPACE_DOC_FIELDS]);
    const { data } = mockPrisma.agentWorkspaceRevision.createMany.mock.calls[0][0];
    expect(data).toHaveLength(WORKSPACE_DOC_FIELDS.length);
    for (const row of data as Array<Record<string, unknown>>) {
      const field = row.field as WorkspaceDocField;
      expect(row.agentId).toBe(agentId);
      expect(row.content).toBe(agent[field]);
      expect(row.contentHash).toBe(documentHash(agent[field]));
      expect(row.actor).toBe('user');
      expect(row.method).toBe('seed');
      expect(row.reason).toBe(UPGRADE_REASON);
    }
  });

  it('records only the documents that have no revision yet', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue(
      WORKSPACE_DOC_FIELDS.filter((field) => field !== 'visionMd').map((field) => ({ field })),
    );

    const recorded = await documentRevisionService.recordMissingBaselines(createAgentRow());

    expect(recorded).toEqual(['visionMd']);
    const { data } = mockPrisma.agentWorkspaceRevision.createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
  });

  it('writes nothing on the second boot', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue(
      WORKSPACE_DOC_FIELDS.map((field) => ({ field })),
    );

    const recorded = await documentRevisionService.recordMissingBaselines(createAgentRow());

    expect(recorded).toEqual([]);
    expect(mockPrisma.agentWorkspaceRevision.createMany).not.toHaveBeenCalled();
  });

  it('reads one row per field rather than the whole history', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);

    await documentRevisionService.recordMissingBaselines(createAgentRow());

    expect(mockPrisma.agentWorkspaceRevision.findMany).toHaveBeenCalledWith({
      where: { agentId },
      distinct: ['field'],
      select: { field: true },
    });
  });
});

describe('documentDrift', () => {
  it('reports no drift while the document matches its newest revision', () => {
    expect(documentDrift('# Soul', { contentHash: documentHash('# Soul') })).toBe(false);
  });

  it('reports drift when the document was written outside the write path', () => {
    expect(documentDrift('# Edited by a shell', { contentHash: documentHash('# Soul') })).toBe(
      true,
    );
  });

  it('reports no drift for a document with no revision yet', () => {
    expect(documentDrift('# Soul', null)).toBe(false);
  });
});

describe('documentRevisionService.history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function summaryOf(content: string, id = 'rev-1') {
    return {
      id,
      actor: 'agent',
      method: 'replace',
      reason: 'Rewrote the tone.',
      contentHash: documentHash(content),
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
    };
  }

  it('reads the revisions newest first, without their content', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([summaryOf('# Soul')]);

    const history = await documentRevisionService.history(
      createAgentRow({ soulMd: '# Soul' }),
      'soulMd',
    );

    expect(mockPrisma.agentWorkspaceRevision.findMany).toHaveBeenCalledWith({
      where: { agentId, field: 'soulMd' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        actor: true,
        method: true,
        reason: true,
        contentHash: true,
        createdAt: true,
      },
    });
    expect(history).toEqual({
      field: 'soulMd',
      bound: MAX_REVISIONS_PER_DOCUMENT,
      drifted: false,
      liveHash: documentHash('# Soul'),
      revisions: [summaryOf('# Soul')],
    });
  });

  it('reports no drift for a document with no revision yet', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);

    const history = await documentRevisionService.history(createAgentRow(), 'visionMd');

    expect(history.drifted).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('reports drift once per drifted content, however often the page polls', async () => {
    const agent = createAgentRow({ userMd: '# Written by a shell' });
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([summaryOf('# User')]);

    const first = await documentRevisionService.history(agent, 'userMd');
    const second = await documentRevisionService.history(agent, 'userMd');

    expect(first.drifted).toBe(true);
    expect(second.drifted).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][1]).toContain('User profile');
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith('agent document drift detected', null, {
      'agent.id': agentId,
      'config.field': 'userMd',
      'document.live_hash': documentHash('# Written by a shell').slice(0, 12),
      'document.revision_hash': documentHash('# User').slice(0, 12),
    });
  });

  it('reports a second out-of-band write, since the content is a new hash', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([summaryOf('# Memory')]);

    await documentRevisionService.history(createAgentRow({ memoryMd: '# First shell write' }), 'memoryMd');
    await documentRevisionService.history(createAgentRow({ memoryMd: '# Second shell write' }), 'memoryMd');

    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });
});

describe('documentRevisionService.get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the read to the agent and the document, so a foreign id is not found', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue(null);

    const revision = await documentRevisionService.get(tx, agentId, 'soulMd', 'rev-9');

    expect(revision).toBeNull();
    expect(mockPrisma.agentWorkspaceRevision.findFirst).toHaveBeenCalledWith({
      where: { id: 'rev-9', agentId, field: 'soulMd' },
    });
  });

  it('answers the revision with its content', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue({
      id: 'rev-2',
      content: '# Soul',
    });

    const revision = await documentRevisionService.get(tx, agentId, 'soulMd', 'rev-2');

    expect(revision).toEqual({ id: 'rev-2', content: '# Soul' });
  });
});

describe('documentRevisionService.newest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the newest revision of one document', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue({ id: 'rev-3' });

    const revision = await documentRevisionService.newest(tx, agentId, 'heartbeatMd');

    expect(revision).toEqual({ id: 'rev-3' });
    expect(mockPrisma.agentWorkspaceRevision.findFirst).toHaveBeenCalledWith({
      where: { agentId, field: 'heartbeatMd' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('answers null while the document has none', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue(null);

    expect(await documentRevisionService.newest(tx, agentId, 'heartbeatMd')).toBeNull();
  });
});
