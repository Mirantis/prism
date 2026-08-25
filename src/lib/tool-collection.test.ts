/**
 * Which tool source wins when two of them claim one name.
 *
 * A built-in has to win. Platform and plugin tools arrive from outside this
 * repository, and several safety mechanisms match a bare tool name: the risk
 * gate's exemption list, the locked-in withholding set, the mode filter. A tool
 * that could answer to `memory_write` would inherit that name's exemptions
 * without being the tool they were written for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';

const { mockGetMCPTools, mockGetPluginTools, mockGetSubagents } = vi.hoisted(() => ({
  mockGetMCPTools: vi.fn(),
  mockGetPluginTools: vi.fn(),
  mockGetSubagents: vi.fn(),
}));

vi.mock('./mcp-client', () => ({ getMCPTools: mockGetMCPTools }));
vi.mock('../services/plugin-mcp.service', () => ({
  pluginMcpService: { getTools: mockGetPluginTools },
}));
vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: { getSubagents: mockGetSubagents },
}));

import { collectTools } from './tool-collection';

/** Identifiable by description, so the winner of a name clash is unambiguous. */
function foreignTool(marker: string): Tool {
  return { description: marker, inputSchema: { type: 'object' } } as unknown as Tool;
}

async function collect() {
  const { tools } = await collectTools({
    userId: 'user-1',
    agentId: 'agent-1',
    mode: 'chat',
    lockedIn: false,
    taskInvoker: vi.fn(),
  });
  return tools;
}

describe('collectTools name precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubagents.mockResolvedValue([]);
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
  });

  it('keeps the built-in when a platform tool claims its name', async () => {
    mockGetMCPTools.mockResolvedValue({ memory_write: foreignTool('from-platform') });

    const tools = await collect();

    expect(tools.memory_write).toBeDefined();
    expect(tools.memory_write.description).not.toBe('from-platform');
  });

  it('keeps the built-in when a plugin tool claims its name', async () => {
    mockGetPluginTools.mockResolvedValue({ memory_write: foreignTool('from-plugin') });

    const tools = await collect();

    expect(tools.memory_write.description).not.toBe('from-plugin');
  });

  it('keeps the platform tool when a plugin claims a name it already took', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl_get: foreignTool('from-platform') });
    mockGetPluginTools.mockResolvedValue({ kubectl_get: foreignTool('from-plugin') });

    const tools = await collect();

    expect(tools.kubectl_get.description).toBe('from-platform');
  });

  it('still registers a platform tool whose name nothing else claims', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl_get: foreignTool('from-platform') });

    const tools = await collect();

    expect(tools.kubectl_get.description).toBe('from-platform');
  });
});
