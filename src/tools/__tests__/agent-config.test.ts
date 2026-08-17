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
  langfuseTelemetry: () => ({}),
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
    // Unlocked by default; the locked-in suite overrides it. The guard reads the
    // live row through agentWorkspaceService.isLockedIn(), which resolves to the
    // mocked prisma.findUnique below, so this field drives the whole gate.
    lockedIn: false,
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

  // ==========================================================================
  // Locked-in mode
  // ==========================================================================

  describe('locked-in mode', () => {
    // Every tool that writes one of the locked markdown fields, with an input
    // that would otherwise succeed.
    const guarded: Array<[string, Record<string, unknown>]> = [
      ['update_soul', { newContent: '# Soul\nrewritten', changeDescription: 'rewrite soul' }],
      ['update_memory', { newContent: '# Memory\nrewritten', changeDescription: 'rewrite memory' }],
      ['update_user_profile', { newContent: '# User\nrewritten', changeDescription: 'rewrite user' }],
      ['update_vision', { newContent: '# Vision\nrewritten', changeDescription: 'rewrite vision' }],
      ['update_heartbeat_config', { newContent: '# Heartbeat\n- check', changeDescription: 'rewrite hb' }],
      ['clear_bootstrap', { confirmationMessage: 'done onboarding' }],
    ];

    beforeEach(() => {
      const locked = createTestAgentWorkspace({ lockedIn: true });
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(locked);
      mockPrisma.agentWorkspace.update.mockResolvedValue(locked);
    });

    it.each(guarded)('%s refuses and performs no write while locked', async (name, input) => {
      const result = (await tools[name].execute(input)) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Locked-in mode is on');
      expect(result.error).toContain('turn locked-in mode off');
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it.each(guarded)('%s emits no config-updated telemetry while locked', async (name, input) => {
      await tools[name].execute(input);

      // Nothing was written, so the write metric must not count it.
      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'agent config updated',
        expect.anything(),
        expect.anything(),
      );
    });

    it.each(guarded)('%s records the refusal as telemetry', async (name, input) => {
      await tools[name].execute(input);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'agent locked write refused',
        null,
        expect.objectContaining({ 'agent.id': expect.any(String) }),
      );
    });

    it('names the refused field in the refusal event', async () => {
      await tools.update_soul.execute({ newContent: '# Soul', changeDescription: 'rewrite' });
      await tools.clear_bootstrap.execute({ confirmationMessage: 'done' });

      const fields = mockTrackEvent.mock.calls
        .filter((c) => c[0] === 'agent locked write refused')
        .map((c) => c[2]['config.field']);
      expect(fields).toEqual(['soulMd', 'bootstrapMd']);
    });

    it('emits exactly one refusal event per refused write', async () => {
      await tools.update_soul.execute({ newContent: '# Soul', changeDescription: 'rewrite' });

      const refusals = mockTrackEvent.mock.calls.filter((c) => c[0] === 'agent locked write refused');
      expect(refusals).toHaveLength(1);
    });

    it('refuses edits mode too, without reading or writing content', async () => {
      const result = (await tools.update_soul.execute({
        edits: [{ oldText: 'helpful', newText: 'terse' }],
        changeDescription: 'tone tweak',
      })) as AgentConfigResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Locked-in mode is on');
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });

    it('does not restart the heartbeat when a locked heartbeat-config write is refused', async () => {
      await tools.update_heartbeat_config.execute({
        newContent: '# Heartbeat\n- check',
        changeDescription: 'rewrite hb',
      });

      expect(mockHeartbeatService.startHeartbeat).not.toHaveBeenCalled();
    });

    // Renames and behavioural settings stay editable while locked — the lock
    // covers the workspace markdown only.
    it('still allows rename_self while locked', async () => {
      mockPrisma.agentWorkspace.update.mockResolvedValue(
        createTestAgentWorkspace({ lockedIn: true, name: 'NewName' }),
      );

      const result = (await tools.rename_self.execute({ name: 'NewName' })) as AgentConfigResult;

      expect(result.success).toBe(true);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { name: 'NewName' },
      });
    });

    it('still allows update_settings (timezone) while locked', async () => {
      const result = (await tools.update_settings.execute({
        setting: 'timezone',
        value: 'Europe/Berlin',
      })) as AgentConfigResult;

      expect(result.success).toBe(true);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { timezone: 'Europe/Berlin' },
      });
    });

    it('still allows update_settings (heartbeatIntervalMs) while locked', async () => {
      const result = (await tools.update_settings.execute({
        setting: 'heartbeatIntervalMs',
        value: 3_600_000,
      })) as AgentConfigResult;

      expect(result.success).toBe(true);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { heartbeatIntervalMs: 3_600_000 },
      });
    });

    // The agent must not be able to unlock itself: `lockedIn` is not in
    // update_settings' setting enum, so the schema rejects it.
    it('does not accept lockedIn as a writable setting', () => {
      const schema = (tools.update_settings as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      }).inputSchema;

      expect(schema.safeParse({ setting: 'lockedIn', value: false }).success).toBe(false);
      expect(schema.safeParse({ setting: 'timezone', value: 'UTC' }).success).toBe(true);
    });

    it('resumes writing once the lock is lifted', async () => {
      const unlocked = createTestAgentWorkspace({ lockedIn: false });
      mockPrisma.agentWorkspace.findUnique.mockResolvedValue(unlocked);
      mockPrisma.agentWorkspace.update.mockResolvedValue(unlocked);

      const result = (await tools.update_soul.execute({
        newContent: '# Soul\nrewritten',
        changeDescription: 'rewrite soul',
      })) as AgentConfigResult;

      expect(result.success).toBe(true);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { soulMd: '# Soul\nrewritten' },
      });
    });
  });
});
