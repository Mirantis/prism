/**
 * Teams Mapping Service Tests
 *
 * Mirrors the Slack mapping service tests: user mappings (DM mode), channel
 * mappings (Team mode), main-channel exclusivity, and the general counts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    teamsMapping: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../lib/prisma', () => ({
  default: mockPrisma,
}));

import { teamsMappingService } from '../teams-mapping.service';

describe('TeamsMappingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('user mappings', () => {
    it('findUserMapping looks up by the connectionId+teamsUserId unique', async () => {
      mockPrisma.teamsMapping.findUnique.mockResolvedValue({ id: 'm1' });

      const result = await teamsMappingService.findUserMapping('tenant-1', 'aad-user-1');

      expect(result).toEqual({ id: 'm1' });
      expect(mockPrisma.teamsMapping.findUnique).toHaveBeenCalledWith({
        where: {
          connectionId_teamsUserId: { connectionId: 'tenant-1', teamsUserId: 'aad-user-1' },
        },
        include: { agentWorkspace: { select: { id: true, name: true } } },
      });
    });

    it('upsertUserMapping nulls the channel fields on create', async () => {
      mockPrisma.teamsMapping.upsert.mockResolvedValue({ id: 'm1' });

      await teamsMappingService.upsertUserMapping(
        'tenant-1',
        'aad-user-1',
        'lens-1',
        'agent-1',
        '19:dm-conversation',
        'tenant-1'
      );

      const call = mockPrisma.teamsMapping.upsert.mock.calls[0][0];
      expect(call.create).toMatchObject({
        connectionId: 'tenant-1',
        teamsUserId: 'aad-user-1',
        lensUserId: 'lens-1',
        agentId: 'agent-1',
        dmConversationId: '19:dm-conversation',
        channelConversationId: null,
        channelName: null,
      });
    });

    it('updateDmConversationId writes the new proactive-send target', async () => {
      await teamsMappingService.updateDmConversationId('m1', '19:new-conversation');

      expect(mockPrisma.teamsMapping.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { dmConversationId: '19:new-conversation' },
      });
    });

    it('deleteUserMapping deletes user rows only', async () => {
      await teamsMappingService.deleteUserMapping('tenant-1', 'lens-1');

      expect(mockPrisma.teamsMapping.deleteMany).toHaveBeenCalledWith({
        where: { connectionId: 'tenant-1', lensUserId: 'lens-1', teamsUserId: { not: null } },
      });
    });
  });

  describe('channel mappings', () => {
    it('findByConversationId looks up by the unique conversation id', async () => {
      mockPrisma.teamsMapping.findUnique.mockResolvedValue({ id: 'm2' });

      const result = await teamsMappingService.findByConversationId('19:abc@thread.tacv2');

      expect(result).toEqual({ id: 'm2' });
      expect(mockPrisma.teamsMapping.findUnique).toHaveBeenCalledWith({
        where: { channelConversationId: '19:abc@thread.tacv2' },
        include: { agentWorkspace: { select: { id: true, userId: true, name: true } } },
      });
    });

    it('createChannelMapping nulls the user fields', async () => {
      mockPrisma.teamsMapping.create.mockResolvedValue({ id: 'm2' });

      await teamsMappingService.createChannelMapping(
        'tenant-1',
        '19:abc@thread.tacv2',
        'agent-1',
        'General',
        'lens-1'
      );

      const call = mockPrisma.teamsMapping.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        channelConversationId: '19:abc@thread.tacv2',
        channelName: 'General',
        teamsUserId: null,
        dmConversationId: null,
      });
    });

    it('deleteChannelMapping deletes by the unique conversation id', async () => {
      await teamsMappingService.deleteChannelMapping('19:abc@thread.tacv2');

      expect(mockPrisma.teamsMapping.delete).toHaveBeenCalledWith({
        where: { channelConversationId: '19:abc@thread.tacv2' },
      });
    });
  });

  describe('setMainChannel', () => {
    it('clears the old flag and sets the new one atomically', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ count: 1 }, { count: 1 }]);

      await teamsMappingService.setMainChannel('agent-1', '19:abc@thread.tacv2');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.teamsMapping.updateMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-1', channelConversationId: { not: null }, isMainChannel: true },
        data: { isMainChannel: false },
      });
      expect(mockPrisma.teamsMapping.updateMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-1', channelConversationId: '19:abc@thread.tacv2' },
        data: { isMainChannel: true },
      });
    });

    it('throws when the channel does not belong to the agent', async () => {
      mockPrisma.$transaction.mockResolvedValue([{ count: 1 }, { count: 0 }]);

      await expect(
        teamsMappingService.setMainChannel('agent-1', '19:other@thread.tacv2')
      ).rejects.toThrow(/No channel mapping/);
    });
  });

  describe('getMainChannel', () => {
    it('prefers the flagged channel', async () => {
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { channelConversationId: '19:old@thread.tacv2', isMainChannel: false },
        { channelConversationId: '19:flagged@thread.tacv2', isMainChannel: true },
      ]);

      expect(await teamsMappingService.getMainChannel('agent-1')).toBe('19:flagged@thread.tacv2');
    });

    it('falls back to the oldest linked channel when none is flagged', async () => {
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        { channelConversationId: '19:oldest@thread.tacv2', isMainChannel: false },
        { channelConversationId: '19:newer@thread.tacv2', isMainChannel: false },
      ]);

      expect(await teamsMappingService.getMainChannel('agent-1')).toBe('19:oldest@thread.tacv2');
      expect(mockPrisma.teamsMapping.findMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-1', channelConversationId: { not: null } },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('returns null when no channels are linked', async () => {
      mockPrisma.teamsMapping.findMany.mockResolvedValue([]);

      expect(await teamsMappingService.getMainChannel('agent-1')).toBeNull();
    });
  });

  describe('general queries', () => {
    it('isChannelLinked counts rows for the conversation id', async () => {
      mockPrisma.teamsMapping.count.mockResolvedValue(1);

      expect(await teamsMappingService.isChannelLinked('19:abc@thread.tacv2')).toBe(true);
      expect(mockPrisma.teamsMapping.count).toHaveBeenCalledWith({
        where: { channelConversationId: '19:abc@thread.tacv2' },
      });
    });

    it('countUserMappings counts DM rows only', async () => {
      mockPrisma.teamsMapping.count.mockResolvedValue(2);

      expect(await teamsMappingService.countUserMappings('lens-1')).toBe(2);
      expect(mockPrisma.teamsMapping.count).toHaveBeenCalledWith({
        where: { lensUserId: 'lens-1', dmConversationId: { not: null } },
      });
    });

    it('countAllMappings counts DM and channel rows', async () => {
      mockPrisma.teamsMapping.count.mockResolvedValue(3);

      expect(await teamsMappingService.countAllMappings('lens-1')).toBe(3);
      expect(mockPrisma.teamsMapping.count).toHaveBeenCalledWith({
        where: {
          lensUserId: 'lens-1',
          OR: [{ dmConversationId: { not: null } }, { channelConversationId: { not: null } }],
        },
      });
    });
  });
});
