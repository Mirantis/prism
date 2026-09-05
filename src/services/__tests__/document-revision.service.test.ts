/**
 * Document Revision Service Tests
 *
 * The revision row itself: the content hash, the reason cap, the retention
 * delete that runs in the caller's transaction, and the boot baseline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspaceRevision: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

import {
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
