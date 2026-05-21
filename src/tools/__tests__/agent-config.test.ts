import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockHeartbeatService, mockEncryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspace: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockHeartbeatService: {
    startHeartbeat: vi.fn(),
  },
  mockEncryptToken: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../services/heartbeat.service', () => ({
  heartbeatService: mockHeartbeatService,
}));

vi.mock('../../utils/encryption', () => ({
  encryptToken: mockEncryptToken,
}));

import { getAgentConfigTools } from '../agent-config';

function createTestAgentWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-456',
    userId: 'user-123',
    name: 'Prism',
    soulMd: '# Soul\nYou are Prism, a helpful assistant.',
    userMd: '# User\nTest user preferences.',
    memoryMd: '# Memory\nNo memories yet.',
    heartbeatMd: '# Heartbeat Instructions\n(No checks configured)',
    visionMd: '',
    bootstrapMd: '',
    agentMd: '',
    nexusMcpAgentToken: null,
    heartbeatIntervalMs: 28800000,
    proactivity: 3,
    verbosity: 3,
    timezone: 'UTC',
    ...overrides,
  };
}

const agentId = 'agent-456';

type ToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

interface AgentConfigResult {
  success: boolean;
  message?: string;
  error?: string;
}

describe('getAgentConfigTools', () => {
  let tools: Record<string, { execute: ToolExecute }>;
  const testAgent = createTestAgentWorkspace();

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.agentWorkspace.update.mockResolvedValue(testAgent);
    mockPrisma.agentWorkspace.findUnique.mockResolvedValue(testAgent);
    tools = getAgentConfigTools(agentId) as unknown as Record<
      string,
      { execute: ToolExecute }
    >;
  });

  it('exposes all expected tools', () => {
    const names = Object.keys(tools);
    expect(names).toEqual(expect.arrayContaining([
      'rename_self',
      'update_soul',
      'update_memory',
      'update_user_profile',
      'update_heartbeat_config',
      'update_settings',
      'update_vision',
      'store_nexus_token',
      'clear_bootstrap',
    ]));
    expect(names).toHaveLength(9);
  });

  describe('rename_self', () => {
    it('updates the agent name via prisma and returns success', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue({
        id: agentId,
        userId: 'user-1',
        name: 'NewName',
      });

      const result = (await tools.rename_self.execute({ name: '  NewName  ' })) as {
        success: boolean;
        newName?: string;
      };

      expect(result.success).toBe(true);
      expect(result.newName).toBe('NewName');
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { name: 'NewName' },
      });
    });

    it('returns an error when the new name is only whitespace', async () => {
      const result = (await tools.rename_self.execute({ name: '   ' })) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it('surfaces prisma errors as a tool error', async () => {
      mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('DB error'));

      const result = (await tools.rename_self.execute({ name: 'NewName' })) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('update_soul', () => {
    it('updates soulMd via prisma (newContent mode)', async () => {
      const result = (await tools.update_soul.execute({
        newContent: '# New Soul',
        changeDescription: 'reset soul',
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { soulMd: '# New Soul' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('update_memory', () => {
    it('updates memoryMd via prisma', async () => {
      await tools.update_memory.execute({
        newContent: '# Memory',
        changeDescription: 'added note',
      });

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { memoryMd: '# Memory' },
      });
    });
  });

  describe('update_user_profile', () => {
    it('replaces userMd with complete new content', async () => {
      const newContent = '## Basics\nLanguage: English\n## Context\nSRE';
      const result = (await tools.update_user_profile.execute({
        newContent,
        changeDescription: 'changed language to English',
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { userMd: newContent },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('update_heartbeat_config', () => {
    it('replaces heartbeatMd and triggers startHeartbeat', async () => {
      const newContent = '## What to Check\n- CPU usage';
      const result = (await tools.update_heartbeat_config.execute({
        newContent,
        changeDescription: 'added CPU check',
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { heartbeatMd: newContent },
      });
      expect(mockPrisma.agentWorkspace.findUnique).toHaveBeenCalledWith({ where: { id: agentId } });
      expect(mockHeartbeatService.startHeartbeat).toHaveBeenCalledWith(testAgent);
      expect(result.success).toBe(true);
    });

    it('does not throw if startHeartbeat fails', async () => {
      mockHeartbeatService.startHeartbeat.mockImplementation(() => {
        throw new Error('runtime down');
      });
      await expect(
        tools.update_heartbeat_config.execute({
          newContent: '# config',
          changeDescription: 'test',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('update_settings', () => {
    it('validates proactivity bounds', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'proactivity', value: 0 }),
      ).rejects.toThrow('Proactivity must be 1-5');
      await expect(
        tools.update_settings.execute({ setting: 'proactivity', value: 6 }),
      ).rejects.toThrow('Proactivity must be 1-5');
    });

    it('validates verbosity bounds', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'verbosity', value: 0 }),
      ).rejects.toThrow('Verbosity must be 1-5');
    });

    it('validates heartbeatIntervalMs minimum', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: 1000 }),
      ).rejects.toThrow('>= 60000ms');
    });

    it('updates proactivity', async () => {
      await tools.update_settings.execute({ setting: 'proactivity', value: 3 });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { proactivity: 3 },
      });
    });

    it('triggers startHeartbeat when heartbeatIntervalMs changes', async () => {
      await tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: 120000 });
      expect(mockHeartbeatService.startHeartbeat).toHaveBeenCalledWith(testAgent);
    });

    it('accepts string-typed heartbeatIntervalMs and coerces to number', async () => {
      await tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: '600000' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { heartbeatIntervalMs: 600000 },
      });
    });

    it('accepts string-typed proactivity and coerces to number', async () => {
      await tools.update_settings.execute({ setting: 'proactivity', value: '3' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { proactivity: 3 },
      });
    });

    it('accepts string-typed verbosity and coerces to number', async () => {
      await tools.update_settings.execute({ setting: 'verbosity', value: '3' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { verbosity: 3 },
      });
    });

    it('success message uses coerced numeric value, not original string', async () => {
      const result = (await tools.update_settings.execute({
        setting: 'heartbeatIntervalMs',
        value: '060000',
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { heartbeatIntervalMs: 60000 },
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('60000');
      expect(result.message).not.toContain('"060000"');
    });

    it('rejects non-numeric string for numeric settings', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: 'notanumber' }),
      ).rejects.toThrow('Heartbeat interval must be a finite integer');
    });

    it('rejects non-integer numeric values for numeric settings', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'proactivity', value: '3.5' }),
      ).rejects.toThrow('Proactivity must be a finite integer');
      await expect(
        tools.update_settings.execute({ setting: 'verbosity', value: Infinity }),
      ).rejects.toThrow('Verbosity must be a finite integer');
    });
  });

  describe('update_vision', () => {
    it('updates visionMd via prisma', async () => {
      await tools.update_vision.execute({
        newContent: '# Vision',
        changeDescription: 'new vision',
      });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { visionMd: '# Vision' },
      });
    });
  });

  describe('store_nexus_token', () => {
    it('encrypts and stores the token', async () => {
      mockEncryptToken.mockReturnValue('encrypted-token');
      await tools.store_nexus_token.execute({ token: 'my-token' });
      expect(mockEncryptToken).toHaveBeenCalledWith('my-token');
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { nexusMcpAgentToken: 'encrypted-token' },
      });
    });
  });

  describe('clear_bootstrap', () => {
    it('clears bootstrapMd', async () => {
      await tools.clear_bootstrap.execute({ confirmationMessage: 'done' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { bootstrapMd: '' },
      });
    });
  });

  describe('edits mode (targeted find-and-replace)', () => {
    it('applies a single edit to update_soul', async () => {
      const agentWithSoul = createTestAgentWorkspace({
        soulMd: '# Soul\nYou are Prism, a helpful assistant.',
      });
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(agentWithSoul);

      const result = (await tools.update_soul.execute({
        edits: [{ oldText: 'helpful assistant', newText: 'friendly companion' }],
        changeDescription: 'changed personality',
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.findUnique).toHaveBeenCalledWith({ where: { id: agentId } });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { soulMd: '# Soul\nYou are Prism, a friendly companion.' },
      });
      expect(result.success).toBe(true);
    });

    it('applies multiple edits to update_user_profile', async () => {
      const agentWithProfile = createTestAgentWorkspace({
        userMd: '# User\nName: Alice\nRole: Engineer\nTimezone: UTC',
      });
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(agentWithProfile);

      await tools.update_user_profile.execute({
        edits: [
          { oldText: 'Name: Alice', newText: 'Name: Bob' },
          { oldText: 'Role: Engineer', newText: 'Role: SRE' },
        ],
        changeDescription: 'updated name and role',
      });

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { userMd: '# User\nName: Bob\nRole: SRE\nTimezone: UTC' },
      });
    });

    it('returns error when edit not found', async () => {
      const result = (await tools.update_memory.execute({
        edits: [{ oldText: 'NONEXISTENT TEXT', newText: 'replacement' }],
        changeDescription: 'attempted edit',
      })) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it('returns error when both newContent and edits are provided', async () => {
      const result = (await tools.update_soul.execute({
        newContent: '# Full replace',
        edits: [{ oldText: 'a', newText: 'b' }],
        changeDescription: 'invalid',
      })) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not both');
    });

    it('returns error when neither newContent nor edits are provided', async () => {
      const result = (await tools.update_soul.execute({
        changeDescription: 'no content',
      })) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provide either');
    });

    it('update_heartbeat_config with successful edit triggers startHeartbeat', async () => {
      const agentWithHeartbeat = createTestAgentWorkspace({
        heartbeatMd: '# Heartbeat\n- Check CPU\n- Check memory',
      });
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(agentWithHeartbeat);

      await tools.update_heartbeat_config.execute({
        edits: [{ oldText: '- Check CPU', newText: '- Check CPU usage > 90%' }],
        changeDescription: 'added threshold',
      });

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { heartbeatMd: '# Heartbeat\n- Check CPU usage > 90%\n- Check memory' },
      });
      expect(mockHeartbeatService.startHeartbeat).toHaveBeenCalledWith(agentWithHeartbeat);
    });

    it('update_heartbeat_config with failed edit does NOT trigger startHeartbeat', async () => {
      const result = (await tools.update_heartbeat_config.execute({
        edits: [{ oldText: 'NONEXISTENT', newText: 'replacement' }],
        changeDescription: 'bad edit',
      })) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(mockHeartbeatService.startHeartbeat).not.toHaveBeenCalled();
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });
  });
});
