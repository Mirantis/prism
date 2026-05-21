/**
 * Slack Mapping Service Tests
 *
 * Tests for SlackMappingService covering:
 * - User mappings (DM/Personal mode): find, upsert, update, delete
 * - Channel mappings (Team mode): find, create, update, delete
 * - General queries: cache building, channel link check, counts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pin singleAgentMode=false at module load — most tests in this file
// exercise the multi-tenant flow (backendClient-mediated SlackConnection
// lookup + active-connection filter). The dedicated single-agent describe
// at the bottom flips this per-test via the outer beforeEach.
vi.mock('../../config', () => ({
  config: { singleAgentMode: false },
}));

// Use vi.hoisted to create mocks that are available before vi.mock hoisting
const { mockPrisma, mockBackendClient, mockGetSlackConfig } = vi.hoisted(() => ({
  mockPrisma: {
    slackMapping: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    agentWorkspace: {
      findUnique: vi.fn(),
    },
  },
  mockBackendClient: {
    getSlackConnection: vi.fn(),
    getActiveSlackConnections: vi.fn(),
  },
  // Single-agent mode resolves SlackConnection via slack-config's
  // env-sourced singleton (see lib/slack-source.ts:21,29). Mocking the
  // singleton source lets the bottom `Single-agent mode` describe block
  // exercise the in-source no-op filter without touching backendClient.
  mockGetSlackConfig: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
}));

vi.mock('../../lib/backend-client', () => ({
  backendClient: mockBackendClient,
}));

vi.mock('../../lib/slack-config', () => ({
  getSlackConfig: mockGetSlackConfig,
}));

import { config } from '../../config';
// Import after mocking
import { slackMappingService } from '../slack-mapping.service';

// File-wide reset: every test starts in multi-tenant mode. The
// `Single-agent mode` describe at the bottom flips this back to true in
// its own inner beforeEach (which runs after this one). Without this
// outer reset, a test running after the single-agent block would inherit
// singleAgentMode=true.
beforeEach(() => {
  (config as { singleAgentMode: boolean }).singleAgentMode = false;
  mockGetSlackConfig.mockReset();
});

// ============================================================================
// Test Data Helpers
// ============================================================================

function createTestUserMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mapping-user-001',
    connectionId: 'conn-001',
    slackUserId: 'U123ABC',
    lensUserId: 'user-001',
    dmChannelId: 'D456DEF',
    slackChannelId: null,
    slackChannelName: null,
    createdAt: new Date('2024-06-01T00:00:00Z'),
    updatedAt: new Date('2024-06-01T00:00:00Z'),
    ...overrides,
  };
}

function createTestChannelMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mapping-channel-001',
    connectionId: 'conn-001',
    slackUserId: null,
    lensUserId: null,
    dmChannelId: null,
    slackChannelId: 'C789GHI',
    slackChannelName: 'team-general',
    createdAt: new Date('2024-06-01T00:00:00Z'),
    updatedAt: new Date('2024-06-01T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// User Mappings (DM Mode)
// ============================================================================

describe('Requirement: User Mappings (DM Mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scenario: findUserMapping', () => {
    it('should find a user mapping by connectionId and slackUserId', async () => {
      const mapping = createTestUserMapping();
      mockPrisma.slackMapping.findUnique.mockResolvedValue(mapping);

      const result = await slackMappingService.findUserMapping('conn-001', 'U123ABC');

      expect(mockPrisma.slackMapping.findUnique).toHaveBeenCalledWith({
        where: {
          connectionId_slackUserId: {
            connectionId: 'conn-001',
            slackUserId: 'U123ABC',
          },
        },
        include: {
          agentWorkspace: {
            select: { id: true, name: true },
          },
        },
      });
      expect(result).toEqual(mapping);
    });

    it('should return null when no mapping exists', async () => {
      mockPrisma.slackMapping.findUnique.mockResolvedValue(null);

      const result = await slackMappingService.findUserMapping('conn-001', 'U_NONEXISTENT');

      expect(result).toBeNull();
    });
  });

  describe('Scenario: findUserMappingsByLensUserId', () => {
    it('should find all user mappings for a Lens user with connection info', async () => {
      const mappings = [
        createTestUserMapping(),
        createTestUserMapping({ id: 'mapping-user-002', connectionId: 'conn-002' }),
      ];
      mockPrisma.slackMapping.findMany.mockResolvedValue(mappings);

      mockBackendClient.getSlackConnection
        .mockResolvedValueOnce({ id: 'conn-001', teamId: 'T001', teamName: 'Workspace 1', isActive: true })
        .mockResolvedValueOnce({ id: 'conn-002', teamId: 'T002', teamName: 'Workspace 2', isActive: true });

      const result = await slackMappingService.findUserMappingsByLensUserId('user-001');

      expect(mockPrisma.slackMapping.findMany).toHaveBeenCalledWith({
        where: {
          lensUserId: 'user-001',
          slackUserId: { not: null },
        },
      });
      expect(result).toHaveLength(2);
      expect(result[0].connection.teamId).toBe('T001');
      expect(result[1].connection.teamId).toBe('T002');
    });

    it('should only return user mappings (not channel mappings)', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([]);

      await slackMappingService.findUserMappingsByLensUserId('user-001');

      // Verify filter includes slackUserId: { not: null }
      const callArgs = mockPrisma.slackMapping.findMany.mock.calls[0][0];
      expect(callArgs.where.slackUserId).toEqual({ not: null });
    });
  });

  describe('Scenario: upsertUserMapping', () => {
    it('should create a new user mapping when none exists', async () => {
      const newMapping = createTestUserMapping();
      mockPrisma.slackMapping.upsert.mockResolvedValue(newMapping);

      const result = await slackMappingService.upsertUserMapping(
        'conn-001',
        'U123ABC',
        'user-001',
        'agent-001',
        'D456DEF'
      );

      expect(mockPrisma.slackMapping.upsert).toHaveBeenCalledWith({
        where: {
          connectionId_slackUserId: {
            connectionId: 'conn-001',
            slackUserId: 'U123ABC',
          },
        },
        update: {
          lensUserId: 'user-001',
          agentId: 'agent-001',
          dmChannelId: 'D456DEF',
          updatedAt: expect.any(Date),
        },
        create: {
          connectionId: 'conn-001',
          agentId: 'agent-001',
          slackUserId: 'U123ABC',
          lensUserId: 'user-001',
          dmChannelId: 'D456DEF',
          slackChannelId: null,
          slackChannelName: null,
        },
      });
      expect(result).toEqual(newMapping);
    });

    it('should update existing mapping when one exists', async () => {
      const updatedMapping = createTestUserMapping({ dmChannelId: 'D_NEW' });
      mockPrisma.slackMapping.upsert.mockResolvedValue(updatedMapping);

      const result = await slackMappingService.upsertUserMapping(
        'conn-001',
        'U123ABC',
        'user-001',
        'agent-001',
        'D_NEW'
      );

      expect(result.dmChannelId).toBe('D_NEW');
    });

    it('should set channel fields to null for user mappings', async () => {
      mockPrisma.slackMapping.upsert.mockResolvedValue(createTestUserMapping());

      await slackMappingService.upsertUserMapping('conn-001', 'U123ABC', 'user-001', 'agent-001');

      const callArgs = mockPrisma.slackMapping.upsert.mock.calls[0][0];
      expect(callArgs.create.slackChannelId).toBeNull();
      expect(callArgs.create.slackChannelName).toBeNull();
    });

    it('should work without dmChannelId parameter', async () => {
      mockPrisma.slackMapping.upsert.mockResolvedValue(
        createTestUserMapping({ dmChannelId: undefined })
      );

      await slackMappingService.upsertUserMapping('conn-001', 'U123ABC', 'user-001', 'agent-001');

      const callArgs = mockPrisma.slackMapping.upsert.mock.calls[0][0];
      expect(callArgs.create.dmChannelId).toBeUndefined();
    });
  });

  describe('Scenario: updateDmChannelId', () => {
    it('should update the DM channel ID for a mapping', async () => {
      mockPrisma.slackMapping.update.mockResolvedValue(
        createTestUserMapping({ dmChannelId: 'D_NEW_CHANNEL' })
      );

      await slackMappingService.updateDmChannelId('mapping-user-001', 'D_NEW_CHANNEL');

      expect(mockPrisma.slackMapping.update).toHaveBeenCalledWith({
        where: { id: 'mapping-user-001' },
        data: { dmChannelId: 'D_NEW_CHANNEL' },
      });
    });
  });

  describe('Scenario: deleteUserMapping', () => {
    it('should delete user mappings for a specific connection and user', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 1 });

      await slackMappingService.deleteUserMapping('conn-001', 'user-001');

      expect(mockPrisma.slackMapping.deleteMany).toHaveBeenCalledWith({
        where: {
          connectionId: 'conn-001',
          lensUserId: 'user-001',
          slackUserId: { not: null },
        },
      });
    });

    it('should only delete user mappings, not channel mappings', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 0 });

      await slackMappingService.deleteUserMapping('conn-001', 'user-001');

      const callArgs = mockPrisma.slackMapping.deleteMany.mock.calls[0][0];
      expect(callArgs.where.slackUserId).toEqual({ not: null });
    });
  });
});

// ============================================================================
// Channel Mappings (Team Mode)
// ============================================================================

describe('Requirement: Channel Mappings (Team Mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scenario: findByChannelId', () => {
    it('should find a channel mapping with connection and user info', async () => {
      const mapping = createTestChannelMapping({ agentId: 'agent-001' });
      mockPrisma.slackMapping.findUnique.mockResolvedValue(mapping);

      mockBackendClient.getSlackConnection.mockResolvedValue({
        id: 'conn-001',
        userId: 'user-001',
        teamId: 'T001',
        teamName: 'Test Workspace',
        isActive: true,
      });

      mockPrisma.agentWorkspace.findUnique.mockResolvedValue({
        id: 'agent-001',
        userId: 'user-001',
        name: 'Prism',
      });

      const result = await slackMappingService.findByChannelId('C789GHI');

      expect(mockPrisma.slackMapping.findUnique).toHaveBeenCalledWith({
        where: { slackChannelId: 'C789GHI' },
      });
      expect(mockBackendClient.getSlackConnection).toHaveBeenCalledWith('conn-001');
      expect(result).not.toBeNull();
      expect(result!.connection.teamId).toBe('T001');
      expect(result!.connection.agent.name).toBe('Prism');
    });

    it('should return null when channel is not linked', async () => {
      mockPrisma.slackMapping.findUnique.mockResolvedValue(null);

      const result = await slackMappingService.findByChannelId('C_NONEXISTENT');

      expect(result).toBeNull();
    });
  });

  describe('Scenario: createChannelMapping', () => {
    it('should create a channel mapping with user fields set to null', async () => {
      const newMapping = createTestChannelMapping();
      mockPrisma.slackMapping.create.mockResolvedValue(newMapping);

      const result = await slackMappingService.createChannelMapping(
        'conn-001',
        'C789GHI',
        'agent-001',
        'team-general'
      );

      expect(mockPrisma.slackMapping.create).toHaveBeenCalledWith({
        data: {
          connectionId: 'conn-001',
          agentId: 'agent-001',
          slackChannelId: 'C789GHI',
          slackChannelName: 'team-general',
          slackUserId: null,
          lensUserId: null,
          dmChannelId: null,
        },
      });
      expect(result.slackChannelId).toBe('C789GHI');
      expect(result.slackUserId).toBeNull();
    });

    it('should create channel mapping without channel name', async () => {
      const newMapping = createTestChannelMapping({ slackChannelName: undefined });
      mockPrisma.slackMapping.create.mockResolvedValue(newMapping);

      await slackMappingService.createChannelMapping('conn-001', 'C789GHI', 'agent-001');

      const callArgs = mockPrisma.slackMapping.create.mock.calls[0][0];
      expect(callArgs.data.slackChannelName).toBeUndefined();
    });
  });

  describe('Scenario: updateChannelMapping', () => {
    it('should update channel mapping display name', async () => {
      mockPrisma.slackMapping.update.mockResolvedValue(
        createTestChannelMapping({ slackChannelName: 'renamed-channel' })
      );

      await slackMappingService.updateChannelMapping('C789GHI', {
        slackChannelName: 'renamed-channel',
      });

      expect(mockPrisma.slackMapping.update).toHaveBeenCalledWith({
        where: { slackChannelId: 'C789GHI' },
        data: { slackChannelName: 'renamed-channel' },
      });
    });
  });

  describe('Scenario: deleteChannelMapping', () => {
    it('should delete a channel mapping by channel ID', async () => {
      mockPrisma.slackMapping.delete.mockResolvedValue(createTestChannelMapping());

      await slackMappingService.deleteChannelMapping('C789GHI');

      expect(mockPrisma.slackMapping.delete).toHaveBeenCalledWith({
        where: { slackChannelId: 'C789GHI' },
      });
    });
  });

  describe('Scenario: deleteByConnectionId', () => {
    it('should delete all mappings (user + channel) for a connection and return the count', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 3 });

      const result = await slackMappingService.deleteByConnectionId('conn-001');

      expect(mockPrisma.slackMapping.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: 'conn-001' },
      });
      expect(result).toBe(3);
    });

    it('should return 0 when no mappings exist for the connection', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 0 });

      const result = await slackMappingService.deleteByConnectionId('conn-nonexistent');

      expect(result).toBe(0);
    });
  });

  describe('Scenario: getChannelMappingsByConnectionId', () => {
    it('should return all channel mappings for a connection', async () => {
      const channelMappings = [
        createTestChannelMapping(),
        createTestChannelMapping({ id: 'mapping-channel-002', slackChannelId: 'C_SECOND' }),
      ];
      mockPrisma.slackMapping.findMany.mockResolvedValue(channelMappings);

      const result = await slackMappingService.getChannelMappingsByConnectionId('conn-001');

      expect(mockPrisma.slackMapping.findMany).toHaveBeenCalledWith({
        where: {
          connectionId: 'conn-001',
          slackChannelId: { not: null },
        },
      });
      expect(result).toHaveLength(2);
    });

    it('should only return channel mappings, not user mappings', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([]);

      await slackMappingService.getChannelMappingsByConnectionId('conn-001');

      const callArgs = mockPrisma.slackMapping.findMany.mock.calls[0][0];
      expect(callArgs.where.slackChannelId).toEqual({ not: null });
    });

    it('should return empty array when no channel mappings exist', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([]);

      const result = await slackMappingService.getChannelMappingsByConnectionId('conn-001');

      expect(result).toHaveLength(0);
    });
  });
});

// ============================================================================
// General Queries
// ============================================================================

describe('Requirement: General Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scenario: getActiveUserMappingsWithDmChannel', () => {
    it('should return active user mappings with DM channel and connection info', async () => {
      const mappings = [createTestUserMapping()];
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([
        { id: 'conn-001', teamId: 'T001', isActive: true },
      ]);
      mockPrisma.slackMapping.findMany.mockResolvedValue(mappings);
      mockBackendClient.getSlackConnection.mockResolvedValue({
        id: 'conn-001', teamId: 'T001', isActive: true,
      });

      const result = await slackMappingService.getActiveUserMappingsWithDmChannel();

      expect(mockPrisma.slackMapping.findMany).toHaveBeenCalledWith({
        where: {
          dmChannelId: { not: null },
          slackUserId: { not: null },
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0].connection.teamId).toBe('T001');
    });

    it('should exclude mappings from inactive connections', async () => {
      // No active connections from backend
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([]);
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        createTestUserMapping(),
      ]);

      const result = await slackMappingService.getActiveUserMappingsWithDmChannel();

      // Mapping's connectionId 'conn-001' is not in the active set, so it's excluded
      expect(result).toHaveLength(0);
    });

    it('should exclude mappings without DM channel', async () => {
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([
        { id: 'conn-001', teamId: 'T001', isActive: true },
      ]);
      mockPrisma.slackMapping.findMany.mockResolvedValue([]);

      await slackMappingService.getActiveUserMappingsWithDmChannel();

      const callArgs = mockPrisma.slackMapping.findMany.mock.calls[0][0];
      expect(callArgs.where.dmChannelId).toEqual({ not: null });
    });
  });

  describe('Scenario: isChannelLinked', () => {
    it('should return true when channel has a mapping', async () => {
      mockPrisma.slackMapping.count.mockResolvedValue(1);

      const result = await slackMappingService.isChannelLinked('C789GHI');

      expect(mockPrisma.slackMapping.count).toHaveBeenCalledWith({
        where: { slackChannelId: 'C789GHI' },
      });
      expect(result).toBe(true);
    });

    it('should return false when channel has no mapping', async () => {
      mockPrisma.slackMapping.count.mockResolvedValue(0);

      const result = await slackMappingService.isChannelLinked('C_NONEXISTENT');

      expect(result).toBe(false);
    });
  });

  describe('Scenario: countUserMappings', () => {
    it('should count active user mappings with DM channel', async () => {
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([
        { id: 'conn-001' },
        { id: 'conn-002' },
        { id: 'conn-003' },
      ]);
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        { connectionId: 'conn-001' },
        { connectionId: 'conn-002' },
        { connectionId: 'conn-003' },
      ]);

      const result = await slackMappingService.countUserMappings('user-001');

      expect(result).toBe(3);
    });

    it('should return 0 when user has no active mappings', async () => {
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([]);
      mockPrisma.slackMapping.findMany.mockResolvedValue([]);

      const result = await slackMappingService.countUserMappings('user-no-slack');

      expect(result).toBe(0);
    });
  });
});

// ============================================================================
// Single-agent mode
//
// In single-agent mode the container holds exactly one Slack connection,
// synthesized from env (`SLACK_BOT_TOKEN`) by `lib/slack-config.ts`. The
// service-side branches that change behavior are:
//
//   - `getActiveConnectionFilter()` returns `() => true` (no-op accept-all),
//     bypassing the multi-tenant `getActiveSlackConnections()` call.
//   - `getSlackConnection(...)` resolves via `getSlackConfig()` instead of
//     `backendClient.getSlackConnection(...)`, returning the singleton
//     regardless of the connectionId persisted on the SlackMapping row.
//
// These tests assert both behaviors, including the negative assertion
// that the multi-tenant code paths (`mockBackendClient.*`) are never hit.
// ============================================================================

describe('Requirement: Single-agent mode (env-sourced singleton + no-op filter)', () => {
  // Synthetic singleton matching what `lib/slack-config.ts` produces: id is
  // the teamId so `connectionId === teamId` for all single-agent mappings
  // created post-link. Pre-link mappings carry whatever connectionId was
  // persisted in the prior multi-tenant DB; getSlackConnection() returns
  // the singleton for them too (legacy path documented in slack-source.ts).
  const singletonRecord = {
    id: 'T_SINGLE',
    teamId: 'T_SINGLE',
    teamName: 'Single-agent workspace',
    botToken: 'xoxb-test',
    botUserId: 'B_SINGLE',
    installedAt: '2024-06-01T00:00:00Z',
    isActive: true,
  };

  beforeEach(() => {
    (config as { singleAgentMode: boolean }).singleAgentMode = true;
    mockGetSlackConfig.mockResolvedValue(singletonRecord);
  });

  describe('Scenario: findUserMappingsByLensUserId', () => {
    it('resolves connection metadata via the env-sourced singleton, not backendClient', async () => {
      const mappings = [
        createTestUserMapping(),
        createTestUserMapping({ id: 'mapping-user-002', connectionId: 'conn-002' }),
      ];
      mockPrisma.slackMapping.findMany.mockResolvedValue(mappings);

      const result = await slackMappingService.findUserMappingsByLensUserId('user-001');

      expect(result).toHaveLength(2);
      // Both mappings carry the singleton's metadata regardless of the
      // (legacy) connectionId persisted on the row.
      expect(result[0].connection.teamId).toBe('T_SINGLE');
      expect(result[1].connection.teamId).toBe('T_SINGLE');
      expect(mockGetSlackConfig).toHaveBeenCalled();
      expect(mockBackendClient.getSlackConnection).not.toHaveBeenCalled();
    });

    it('skips a mapping when getSlackConfig returns null (token unset / boot failure)', async () => {
      mockGetSlackConfig.mockResolvedValue(null);
      mockPrisma.slackMapping.findMany.mockResolvedValue([createTestUserMapping()]);

      const result = await slackMappingService.findUserMappingsByLensUserId('user-001');

      expect(result).toHaveLength(0);
      expect(mockBackendClient.getSlackConnection).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: getActiveUserMappingsWithDmChannel', () => {
    it('returns every mapping (no-op filter), each tagged with the singleton', async () => {
      // Three user mappings spanning three distinct connectionIds. In
      // multi-tenant the active-set filter would drop any that aren't
      // currently active; in single-agent every mapping passes.
      const mappings = [
        createTestUserMapping({ id: 'm1', connectionId: 'conn-001' }),
        createTestUserMapping({ id: 'm2', connectionId: 'conn-002' }),
        createTestUserMapping({ id: 'm3', connectionId: 'conn-003' }),
      ];
      mockPrisma.slackMapping.findMany.mockResolvedValue(mappings);

      const result = await slackMappingService.getActiveUserMappingsWithDmChannel();

      expect(result).toHaveLength(3);
      for (const r of result) {
        expect(r.connection.teamId).toBe('T_SINGLE');
        expect(r.connection.isActive).toBe(true);
      }
      expect(mockBackendClient.getActiveSlackConnections).not.toHaveBeenCalled();
      expect(mockBackendClient.getSlackConnection).not.toHaveBeenCalled();
    });

    it('omits mappings when the singleton is unavailable (pre-token-validate boot)', async () => {
      mockGetSlackConfig.mockResolvedValue(null);
      mockPrisma.slackMapping.findMany.mockResolvedValue([createTestUserMapping()]);

      const result = await slackMappingService.getActiveUserMappingsWithDmChannel();

      expect(result).toHaveLength(0);
      expect(mockBackendClient.getActiveSlackConnections).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: countUserMappings', () => {
    it('counts every matching mapping (no-op filter), regardless of connectionId', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        { connectionId: 'conn-001' },
        { connectionId: 'conn-002' }, // would be filtered out in multi-tenant if not active
        { connectionId: 'conn-stale' }, // ditto
      ]);

      const count = await slackMappingService.countUserMappings('user-001');

      expect(count).toBe(3);
      expect(mockBackendClient.getActiveSlackConnections).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: countAllMappings', () => {
    it('counts every matching mapping across DM and channel rows', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        { connectionId: 'conn-001' },
        { connectionId: 'conn-002' },
      ]);

      const count = await slackMappingService.countAllMappings('user-001');

      expect(count).toBe(2);
      expect(mockBackendClient.getActiveSlackConnections).not.toHaveBeenCalled();
    });
  });
});
