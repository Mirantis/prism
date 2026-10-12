/**
 * Agent Workspace Service Tests
 *
 * Covers the product-telemetry emissions for agent CRUD, model override,
 * and subagent wiring. The CRUD behavior itself is exercised through the
 * management route tests; here we assert each mutation emits its event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockTrackEvent } = vi.hoisted(() => {
  const prisma = {
    // The transaction client is the same mock, so a write inside a transaction
    // is asserted like any other.
    $transaction: vi.fn(),
    agentWorkspace: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    agentWorkspaceRevision: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    agentSubagent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { mockPrisma: prisma, mockTrackEvent: vi.fn() };
});

vi.mock('../../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

import { agentWorkspaceService } from '../agent-workspace.service';
import { WORKSPACE_DOC_FIELDS } from '../../lib/workspace-docs';
import { config } from '../../config';
import { getDefaultWorkspaceFiles } from '../../templates/default-workspace';

// config.agentId is mocked globally to 'test-agent-id' (test-utils/setup.ts).
const agentId = 'test-agent-id';

function createAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    userId: 'user-1',
    name: 'Prism',
    agentType: 'AGENT',
    model: null,
    // Every identity document, since a write to one records its content.
    agentMd: '# Guide',
    soulMd: '# Soul',
    userMd: '# User',
    heartbeatMd: '# Heartbeat',
    memoryMd: '# Memory',
    visionMd: '',
    bootstrapMd: '# Bootstrap',
    ...overrides,
  };
}

describe('AgentWorkspaceService telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.agentWorkspace.findUnique.mockResolvedValue(createAgentRow());
    mockPrisma.agentWorkspaceRevision.create.mockResolvedValue({ id: 'rev-1' });
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
  });

  it('emits "agent created" with the agent type on createAgent', async () => {
    mockPrisma.agentWorkspace.create.mockResolvedValue(
      createAgentRow({ id: 'agent-new', agentType: 'SUBAGENT' }),
    );

    await agentWorkspaceService.createAgent({
      id: 'agent-new',
      userId: 'user-1',
      name: 'Helper',
      agentType: 'SUBAGENT',
      teamName: 'Team',
    });

    expect(mockTrackEvent).toHaveBeenCalledWith('agent created', 'user-1', {
      'agent.id': 'agent-new',
      'agent.type': 'SUBAGENT',
    });
  });

  it('seeds model overrides from config.agentDefaults on createAgent', async () => {
    const prev = config.agentDefaults;
    config.agentDefaults = {
      model: 'us.anthropic.main',
      heartbeatModel: 'us.anthropic.hb',
      cronModel: 'us.anthropic.cron',
    };
    try {
      mockPrisma.agentWorkspace.create.mockResolvedValue(createAgentRow({ id: 'agent-new' }));
      await agentWorkspaceService.createAgent({
        id: 'agent-new',
        userId: 'user-1',
        name: 'Helper',
        agentType: 'AGENT',
        teamName: 'Team',
      });
      expect(mockPrisma.agentWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            model: 'us.anthropic.main',
            heartbeatModel: 'us.anthropic.hb',
            cronModel: 'us.anthropic.cron',
          }),
        }),
      );
    } finally {
      config.agentDefaults = prev;
    }
  });

  it('creates the agent with null model overrides when no settings defaults are set', async () => {
    // config.agentDefaults is {} in the test config mock (setup.ts).
    mockPrisma.agentWorkspace.create.mockResolvedValue(createAgentRow({ id: 'agent-new' }));
    await agentWorkspaceService.createAgent({
      id: 'agent-new',
      userId: 'user-1',
      name: 'Helper',
      agentType: 'AGENT',
      teamName: 'Team',
    });
    expect(mockPrisma.agentWorkspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ model: null, heartbeatModel: null, cronModel: null }),
      }),
    );
  });

  it('creates the agent holding the seeded documents', async () => {
    // A template reaches an agent only here, at creation; an existing row keeps what
    // it holds.
    mockPrisma.agentWorkspace.create.mockResolvedValue(createAgentRow({ id: 'agent-new' }));
    await agentWorkspaceService.createAgent({
      id: 'agent-new',
      userId: 'user-1',
      name: 'Helper',
      agentType: 'AGENT',
      teamName: 'Team',
    });

    const { data } = mockPrisma.agentWorkspace.create.mock.calls[0][0];
    const { bootstrapMd: _bootstrap, ...seeded } = getDefaultWorkspaceFiles();
    expect(data).toMatchObject(seeded);
    expect(data.bootstrapMd).toContain('Helper');
    expect(data.bootstrapMd).not.toContain('{{');
  });

  it('emits "agent deleted" on successful deleteAgent', async () => {
    mockPrisma.agentWorkspace.delete.mockResolvedValue({});

    const result = await agentWorkspaceService.deleteAgent({ userId: 'user-1' });

    expect(result).toBe('deleted');
    expect(mockTrackEvent).toHaveBeenCalledWith('agent deleted', 'user-1', {
      'agent.id': agentId,
    });
  });

  it('does not emit "agent deleted" when the ownership check fails', async () => {
    const result = await agentWorkspaceService.deleteAgent({ userId: 'someone-else' });

    expect(result).toBe('forbidden');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "agent renamed" with the new name on renameAgent', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow({ name: 'NewName' }));

    await agentWorkspaceService.renameAgent('NewName');

    expect(mockTrackEvent).toHaveBeenCalledWith('agent renamed', null, {
      'agent.id': agentId,
      'agent.name': 'NewName',
    });
  });

  it('does not emit "agent renamed" when validation rejects the name', async () => {
    await expect(agentWorkspaceService.renameAgent('   ')).rejects.toThrow('non-empty');

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "agent model updated" with the resolved model on updateModel', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(
      createAgentRow({ model: 'us.anthropic.claude-opus-4-8' }),
    );

    await agentWorkspaceService.updateModel('us.anthropic.claude-opus-4-8');

    expect(mockTrackEvent).toHaveBeenCalledWith('agent model updated', null, {
      'agent.id': agentId,
      'agent.model': 'us.anthropic.claude-opus-4-8',
    });
  });

  it('emits "agent heartbeat model updated" with the resolved model on updateHeartbeatModel', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(
      createAgentRow({ heartbeatModel: 'us.anthropic.claude-haiku-4-5', model: null }),
    );

    const result = await agentWorkspaceService.updateHeartbeatModel('us.anthropic.claude-haiku-4-5');

    expect(result).toEqual({
      override: 'us.anthropic.claude-haiku-4-5',
      effective: 'us.anthropic.claude-haiku-4-5',
    });
    expect(mockTrackEvent).toHaveBeenCalledWith('agent heartbeat model updated', null, {
      'agent.id': agentId,
      'agent.model': 'us.anthropic.claude-haiku-4-5',
    });
  });

  it('emits "agent cron model updated" with the resolved model on updateCronModel', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(
      createAgentRow({ cronModel: 'us.anthropic.claude-sonnet-4-6', model: null }),
    );

    const result = await agentWorkspaceService.updateCronModel('us.anthropic.claude-sonnet-4-6');

    expect(result).toEqual({
      override: 'us.anthropic.claude-sonnet-4-6',
      effective: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(mockTrackEvent).toHaveBeenCalledWith('agent cron model updated', null, {
      'agent.id': agentId,
      'agent.model': 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('clearing the heartbeat override falls back to the main model in the effective result', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(
      createAgentRow({ heartbeatModel: null, model: 'us.anthropic.main-override' }),
    );

    const result = await agentWorkspaceService.updateHeartbeatModel(null);

    // override cleared, effective resolves to the main per-agent override
    expect(result).toEqual({ override: null, effective: 'us.anthropic.main-override' });
    expect(mockTrackEvent).toHaveBeenCalledWith('agent heartbeat model updated', null, {
      'agent.id': agentId,
      'agent.model': 'us.anthropic.main-override',
    });
  });

  it('rejects a malformed heartbeat model without emitting telemetry', async () => {
    await expect(agentWorkspaceService.updateHeartbeatModel('has spaces')).rejects.toThrow();
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "agent locked-in updated" and returns the persisted value on updateLockedIn', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow({ lockedIn: true }));

    const result = await agentWorkspaceService.updateLockedIn(true);

    expect(result).toBe(true);
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: agentId },
      data: { lockedIn: true },
    });
    expect(mockTrackEvent).toHaveBeenCalledWith('agent locked-in updated', null, {
      'agent.id': agentId,
      'agent.locked_in': 'true',
    });
  });

  it('unlocks and reports the persisted value on updateLockedIn(false)', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow({ lockedIn: false }));

    const result = await agentWorkspaceService.updateLockedIn(false);

    expect(result).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith('agent locked-in updated', null, {
      'agent.id': agentId,
      'agent.locked_in': 'false',
    });
  });

  it('rejects a non-boolean lockedIn without writing or emitting telemetry', async () => {
    await expect(agentWorkspaceService.updateLockedIn('yes')).rejects.toThrow('boolean');

    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('isLockedIn reads the live row rather than a cached value', async () => {
    mockPrisma.agentWorkspace.findUnique.mockResolvedValueOnce(createAgentRow({ lockedIn: false }));
    expect(await agentWorkspaceService.isLockedIn()).toBe(false);

    // A toggle between reads must be observed.
    mockPrisma.agentWorkspace.findUnique.mockResolvedValueOnce(createAgentRow({ lockedIn: true }));
    expect(await agentWorkspaceService.isLockedIn()).toBe(true);
  });

  it('emits "subagent added" on successful addSubagent', async () => {
    mockPrisma.agentWorkspace.findUnique
      .mockResolvedValueOnce(createAgentRow()) // parent
      .mockResolvedValueOnce(createAgentRow({ id: 'child-1', agentType: 'SUBAGENT' })); // child
    mockPrisma.agentSubagent.findUnique.mockResolvedValue(null);
    mockPrisma.agentSubagent.create.mockResolvedValue({});

    await agentWorkspaceService.addSubagent(agentId, 'child-1');

    expect(mockTrackEvent).toHaveBeenCalledWith('subagent added', null, {
      'agent.id': agentId,
      'subagent.id': 'child-1',
    });
  });

  it('does not emit "subagent added" when the link already exists', async () => {
    mockPrisma.agentWorkspace.findUnique
      .mockResolvedValueOnce(createAgentRow())
      .mockResolvedValueOnce(createAgentRow({ id: 'child-1', agentType: 'SUBAGENT' }));
    mockPrisma.agentSubagent.findUnique.mockResolvedValue({ id: 'link-1' });

    const result = await agentWorkspaceService.addSubagent(agentId, 'child-1');

    expect(result).toBe('already_exists');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits "subagent removed" on successful removeSubagent', async () => {
    mockPrisma.agentSubagent.findUnique.mockResolvedValue({ id: 'link-1' });
    mockPrisma.agentSubagent.delete.mockResolvedValue({});

    const result = await agentWorkspaceService.removeSubagent(agentId, 'child-1');

    expect(result).toBe('deleted');
    expect(mockTrackEvent).toHaveBeenCalledWith('subagent removed', null, {
      'agent.id': agentId,
      'subagent.id': 'child-1',
    });
  });

  it('does not emit "subagent removed" when the link is missing', async () => {
    mockPrisma.agentSubagent.findUnique.mockResolvedValue(null);

    const result = await agentWorkspaceService.removeSubagent(agentId, 'child-1');

    expect(result).toBe('link_not_found');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe('AgentWorkspaceService identity-document writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.agentWorkspace.findUnique.mockResolvedValue(createAgentRow());
    mockPrisma.agentWorkspaceRevision.create.mockResolvedValue({ id: 'rev-1' });
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
  });

  it('writes the column and appends one revision in the same transaction', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow({ soulMd: '# Rewritten' }));

    const stored = await agentWorkspaceService.writeWorkspaceDoc({
      agentId,
      field: 'soulMd',
      content: '# Rewritten',
      actor: 'agent',
      method: 'replace',
      reason: 'Sharpened the tone.',
    });

    expect(stored).toBe('# Rewritten');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: agentId },
      data: { soulMd: '# Rewritten' },
    });
    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: {
        agentId,
        field: 'soulMd',
        content: '# Rewritten',
        actor: 'agent',
        method: 'replace',
        reason: 'Sharpened the tone.',
      },
    });
  });

  it('writes no revision when the column write rejects', async () => {
    mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('database is locked'));

    await expect(
      agentWorkspaceService.writeWorkspaceDoc({
        agentId,
        field: 'soulMd',
        content: '# Rewritten',
        actor: 'agent',
        method: 'replace',
        reason: 'Sharpened the tone.',
      }),
    ).rejects.toThrow('database is locked');

    expect(mockPrisma.agentWorkspaceRevision.create).not.toHaveBeenCalled();
  });

  it('records a seed revision for each of the seven documents on createAgent', async () => {
    const created = createAgentRow({ id: 'agent-new' });
    mockPrisma.agentWorkspace.create.mockResolvedValue(created);

    await agentWorkspaceService.createAgent({
      id: 'agent-new',
      userId: 'user-1',
      name: 'Helper',
      agentType: 'AGENT',
      teamName: 'Team',
    });

    const { data } = mockPrisma.agentWorkspaceRevision.createMany.mock.calls[0][0];
    expect(data.map((row: Record<string, unknown>) => row.field)).toEqual([
      ...WORKSPACE_DOC_FIELDS,
    ]);
    for (const row of data as Array<Record<string, unknown>>) {
      expect(row.agentId).toBe('agent-new');
      expect(row.actor).toBe('user');
      expect(row.method).toBe('seed');
      expect(row.content).toBe(created[row.field as keyof typeof created]);
    }
  });

  // Every one of the seven is writable over REST, so the shape is asserted for
  // each rather than for the guide alone.
  it.each(WORKSPACE_DOC_FIELDS)(
    'records a user REST write of %s carrying the reason',
    async (field) => {
      mockPrisma.agentWorkspace.update.mockResolvedValue(
        createAgentRow({ [field]: '# New text' }),
      );

      const stored = await agentWorkspaceService.updateWorkspaceDoc(
        field,
        '# New text',
        'Added a lint rule.',
      );

      expect(stored).toBe('# New text');
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { [field]: '# New text' },
      });
      expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          field,
          actor: 'user',
          method: 'rest',
          reason: 'Added a lint rule.',
        }),
      });
      // The revision does not double the event the write already emitted.
      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
        'agent.id': agentId,
        'config.field': field,
        'config.method': 'rest',
      });
    },
  );

  it('records an empty reason when the write supplies none', async () => {
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow({ soulMd: '' }));

    await agentWorkspaceService.updateWorkspaceDoc('soulMd', '');

    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ field: 'soulMd', content: '', reason: '' }),
    });
  });

  it('rejects a non-string document without writing a revision', async () => {
    await expect(agentWorkspaceService.updateWorkspaceDoc('soulMd', 42)).rejects.toThrow(
      'soulMd must be a string',
    );

    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockPrisma.agentWorkspaceRevision.create).not.toHaveBeenCalled();
  });
});

describe('AgentWorkspaceService.rollbackWorkspaceDoc', () => {
  const target = {
    id: 'rev-old',
    content: '# The soul as it was',
    createdAt: new Date('2026-09-01T08:30:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow());
    mockPrisma.agentWorkspaceRevision.create.mockResolvedValue({ id: 'rev-new' });
    mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
    // The target revision, then the newest one the caller expects.
    mockPrisma.agentWorkspaceRevision.findFirst
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ id: 'rev-newest' });
  });

  function restore(overrides: Record<string, unknown> = {}) {
    return agentWorkspaceService.rollbackWorkspaceDoc({
      agentId,
      field: 'soulMd',
      revisionId: 'rev-old',
      expectedRevisionId: 'rev-newest',
      reason: 'Undid the edit from yesterday.',
      ...overrides,
    });
  }

  it('writes the restored content and appends a rollback revision in one transaction', async () => {
    const result = await restore();

    expect(result).toEqual({
      status: 'restored',
      content: '# The soul as it was',
      revision: { id: 'rev-new' },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: agentId },
      data: { soulMd: '# The soul as it was' },
    });
    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: {
        agentId,
        field: 'soulMd',
        content: '# The soul as it was',
        actor: 'user',
        method: 'rollback',
        reason: 'Undid the edit from yesterday.',
      },
    });
    expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
      'agent.id': agentId,
      'config.field': 'soulMd',
      'config.method': 'rollback',
    });
  });

  it('records when the restored revision was written, for a caller that gives no reason', async () => {
    await restore({ reason: '   ' });

    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: 'Restored the revision from 2026-09-01T08:30:00.000Z.',
      }),
    });
  });

  it('refuses a stale expected revision without writing', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockReset();
    mockPrisma.agentWorkspaceRevision.findFirst
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ id: 'rev-written-since' });

    const result = await restore();

    expect(result).toEqual({ status: 'stale', newestRevisionId: 'rev-written-since' });
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockPrisma.agentWorkspaceRevision.create).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith('agent document restore refused', null, {
      'agent.id': agentId,
      'config.field': 'soulMd',
      'restore.refusal': 'stale_revision',
    });
  });

  it('reports a revision id that belongs to another document as not found', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockReset();
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue(null);

    const result = await restore();

    expect(result).toEqual({ status: 'revision_not_found' });
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
