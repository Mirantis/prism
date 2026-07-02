import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockHeartbeatService, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    agentWorkspace: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockHeartbeatService: {
    startHeartbeat: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../services/heartbeat.service', () => ({
  heartbeatService: mockHeartbeatService,
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

import { getAgentConfigTools } from '../agent-config';

function createTestAgentWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-agent-id',
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
    timezone: 'UTC',
    ...overrides,
  };
}

const agentId = 'test-agent-id';

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
    tools = getAgentConfigTools() as unknown as Record<
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
      'clear_bootstrap',
    ]));
    expect(names).toHaveLength(8);
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
    it('validates heartbeatIntervalMs minimum', async () => {
      await expect(
        tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: 1000 }),
      ).rejects.toThrow('>= 60000ms');
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
        tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: '60000.5' }),
      ).rejects.toThrow('Heartbeat interval must be a finite integer');
      await expect(
        tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: Infinity }),
      ).rejects.toThrow('Heartbeat interval must be a finite integer');
    });

    it('updates verbose with a boolean', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue(createTestAgentWorkspace({ verbose: true }));

      const result = (await tools.update_settings.execute({
        setting: 'verbose',
        value: true,
      })) as AgentConfigResult;

      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { verbose: true },
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('true');
    });

    it('accepts only the exact strings "true"/"false" for verbose', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue(createTestAgentWorkspace({ verbose: true }));
      await tools.update_settings.execute({ setting: 'verbose', value: 'true' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { verbose: true },
      });

      mockPrisma.agentWorkspace.update.mockClear();
      mockPrisma.agentWorkspace.update.mockResolvedValue(createTestAgentWorkspace({ verbose: false }));
      await tools.update_settings.execute({ setting: 'verbose', value: 'false' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { verbose: false },
      });
    });

    it('rejects non-boolean verbose values instead of coercing them to false', async () => {
      for (const value of ['yes', '1', '', 5]) {
        await expect(
          tools.update_settings.execute({ setting: 'verbose', value }),
        ).rejects.toThrow('verbose must be a boolean');
      }
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it('emits "agent verbose updated" (via updateVerbose) and not the generic config event', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue(createTestAgentWorkspace({ verbose: true }));

      await tools.update_settings.execute({ setting: 'verbose', value: true });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent verbose updated', null, {
        'agent.id': agentId,
        'agent.verbose': 'true',
      });
      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'agent config updated',
        expect.anything(),
        expect.anything(),
      );
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

  describe('clear_bootstrap', () => {
    it('clears bootstrapMd', async () => {
      await tools.clear_bootstrap.execute({ confirmationMessage: 'done' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { bootstrapMd: '' },
      });
    });
  });

  describe('telemetry', () => {
    it('emits "agent config updated" with the field and method on workspace-file replace', async () => {
      await tools.update_soul.execute({
        newContent: '# New Soul',
        changeDescription: 'reset soul',
      });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
        'agent.id': agentId,
        'config.field': 'soulMd',
        'config.method': 'replace',
      });
    });

    it('emits "agent config updated" with method=edit on targeted edits', async () => {
      await tools.update_soul.execute({
        edits: [{ oldText: 'helpful assistant', newText: 'friendly companion' }],
        changeDescription: 'changed personality',
      });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
        'agent.id': agentId,
        'config.field': 'soulMd',
        'config.method': 'edit',
      });
    });

    it('does not emit when the update fails', async () => {
      await tools.update_memory.execute({
        edits: [{ oldText: 'NONEXISTENT TEXT', newText: 'replacement' }],
        changeDescription: 'attempted edit',
      });

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "agent config updated" for settings changes without the value (could be private)', async () => {
      await tools.update_settings.execute({ setting: 'heartbeatIntervalMs', value: '600000' });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
        'agent.id': agentId,
        'config.field': 'heartbeatIntervalMs',
        'config.method': 'set',
      });
    });

    it('emits "agent renamed" with the new name', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue({
        id: agentId,
        userId: 'user-1',
        name: 'NewName',
      });

      await tools.rename_self.execute({ name: 'NewName' });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent renamed', null, {
        'agent.id': agentId,
        'agent.name': 'NewName',
      });
    });

    it('emits "agent config updated" with method=clear on clear_bootstrap', async () => {
      await tools.clear_bootstrap.execute({ confirmationMessage: 'done' });

      expect(mockTrackEvent).toHaveBeenCalledWith('agent config updated', null, {
        'agent.id': agentId,
        'config.field': 'bootstrapMd',
        'config.method': 'clear',
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
