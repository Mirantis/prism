/**
 * Tests for single-agent-bootstrap: resolve-or-create the one
 * AgentWorkspace the runtime runs against.
 *
 * Mocks Prisma + agentWorkspaceService so each case is isolated to its
 * resolution branch (AGENT_ID set/unset × row exists/missing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentWorkspace } from '@prisma/client';

const { mockFindUnique, mockFindFirst, mockCreateAgent, mockInfo } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindFirst: vi.fn(),
  mockCreateAgent: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('../logger', () => ({ logger: { info: mockInfo, warn: vi.fn() } }));

vi.mock('../config', () => ({
  config: {
    agentId: undefined as string | undefined,
    ownerUserId: '00000000-0000-0000-0000-000000000001',
    agentName: 'Prism',
    teamName: 'Local',
    workspaceSeedDir: '/seed',
  },
}));

vi.mock('./prisma', () => ({
  prisma: {
    agentWorkspace: {
      findUnique: mockFindUnique,
      findFirst: mockFindFirst,
    },
  },
}));

vi.mock('./workspace-seed', () => ({
  readWorkspaceSeed: (dir: string | undefined) => (dir === '/seed' ? { soulMd: '# Seeded soul' } : {}),
}));

vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: {
    createAgent: mockCreateAgent,
  },
}));

import { config } from '../config';
import { resolveOrBootstrapSingleAgent } from './single-agent-bootstrap';

const fixture = (id: string, overrides: Partial<AgentWorkspace> = {}): AgentWorkspace =>
  ({
    id,
    userId: 'owner',
    name: 'Prism',
    agentType: 'AGENT',
    ...overrides,
  }) as AgentWorkspace;

describe('resolveOrBootstrapSingleAgent', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFindFirst.mockReset();
    mockCreateAgent.mockReset();
    (config as { agentId?: string }).agentId = undefined;
    (config as { ownerUserId: string }).ownerUserId = '00000000-0000-0000-0000-000000000001';
  });

  it('uses existing row when AGENT_ID is set and row exists', async () => {
    (config as { agentId?: string }).agentId = 'fixed-id';
    mockFindUnique.mockResolvedValue(fixture('fixed-id'));

    const agent = await resolveOrBootstrapSingleAgent();

    expect(agent.id).toBe('fixed-id');
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'fixed-id' } });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('bootstraps with the supplied AGENT_ID when row is missing', async () => {
    (config as { agentId?: string }).agentId = 'fixed-id';
    mockFindUnique.mockResolvedValue(null);
    mockCreateAgent.mockResolvedValue(fixture('fixed-id'));

    const agent = await resolveOrBootstrapSingleAgent();

    expect(agent.id).toBe('fixed-id');
    expect(mockCreateAgent).toHaveBeenCalledWith({
      id: 'fixed-id',
      userId: '00000000-0000-0000-0000-000000000001',
      name: 'Prism',
      agentType: 'AGENT',
      teamName: 'Local',
      documents: { soulMd: '# Seeded soul' },
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
    // The bootstrap log names the seeded fields.
    expect(mockInfo).toHaveBeenCalledWith(expect.objectContaining({ seeded: ['soulMd'] }), expect.stringContaining('bootstrapped'));
  });

  it('uses findFirst when AGENT_ID is unset and DB has a row', async () => {
    mockFindFirst.mockResolvedValue(fixture('discovered-id'));

    const agent = await resolveOrBootstrapSingleAgent();

    expect(agent.id).toBe('discovered-id');
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockFindFirst).toHaveBeenCalled();
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('bootstraps with a generated UUID when AGENT_ID is unset and DB is empty', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreateAgent.mockImplementation(async ({ id }) => fixture(id));

    const agent = await resolveOrBootstrapSingleAgent();

    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const callArg = mockCreateAgent.mock.calls[0][0];
    expect(callArg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(callArg.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(agent.id).toBe(callArg.id);
  });

  it('pins resolved id into config.agentId so downstream readers get a consistent value', async () => {
    mockFindFirst.mockResolvedValue(fixture('discovered-id'));

    await resolveOrBootstrapSingleAgent();

    expect(config.agentId).toBe('discovered-id');
  });

  it('pins the owner from the existing row when it differs from OWNER_USER_ID', async () => {
    (config as { agentId?: string }).agentId = 'fixed-id';
    mockFindUnique.mockResolvedValue(fixture('fixed-id', { userId: 'agent-record-user' }));

    await resolveOrBootstrapSingleAgent();

    expect(config.ownerUserId).toBe('agent-record-user');
  });
});
