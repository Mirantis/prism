/**
 * Agent Workspace Service Tests
 *
 * Covers the product-telemetry emissions for agent CRUD, model override,
 * and subagent wiring. The CRUD behavior itself is exercised through the
 * management route tests; here we assert each mutation emits its event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspace: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    agentSubagent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

import { agentWorkspaceService } from '../agent-workspace.service';

// config.agentId is mocked globally to 'test-agent-id' (test-utils/setup.ts).
const agentId = 'test-agent-id';

function createAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    userId: 'user-1',
    name: 'Prism',
    agentType: 'AGENT',
    model: null,
    ...overrides,
  };
}

describe('AgentWorkspaceService telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspace.findUnique.mockResolvedValue(createAgentRow());
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
