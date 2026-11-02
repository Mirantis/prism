/**
 * Which tool source wins when two of them claim one name.
 *
 * A built-in has to win. Platform and plugin tools arrive from outside this
 * repository, and several safety mechanisms match a bare tool name: the risk
 * gate's exemption list, the locked-in withholding set, the mode filter. A tool
 * that could answer to `memory_write` would inherit that name's exemptions
 * without being the tool they were written for.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Tool } from 'ai';

const { mockGetMCPTools, mockGetPluginTools, mockGetSubagents } = vi.hoisted(() => ({
  mockGetMCPTools: vi.fn(),
  mockGetPluginTools: vi.fn(),
  mockGetSubagents: vi.fn(),
}));

vi.mock('./mcp-client', () => ({ getMCPTools: mockGetMCPTools }));
const { mockGetThreadSource } = vi.hoisted(() => ({ mockGetThreadSource: vi.fn() }));
vi.mock('../services/conversation.service', async (original) => ({
  ...(await original<typeof import('../services/conversation.service')>()),
  conversationService: { getThreadSource: mockGetThreadSource },
}));
vi.mock('../services/plugin-mcp.service', () => ({
  pluginMcpService: { getTools: mockGetPluginTools },
}));
vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: { getSubagents: mockGetSubagents },
}));

vi.mock('./has-binary', () => ({ missingBinary: vi.fn(async () => null) }));
vi.mock('../services/meeting/browser-stack', async (original) => ({
  ...(await original<typeof import('../services/meeting/browser-stack')>()),
  isBrowserAvailable: vi.fn(async () => true),
}));
import { initComputerAvailability } from '../services/computer/supported';
beforeAll(async () => {
  await initComputerAvailability();
});

import { collectTools } from './tool-collection';
import { attachmentService } from '../services/attachment.service';

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

  it('registers the message tools', async () => {
    const tools = await collect();

    expect(tools.send_message).toBeDefined();
    expect(tools.list_message_targets).toBeDefined();
  });

  it('drops share_file from a run with a posting ceiling, whose posts carry no file, and keeps its name reserved', async () => {
    mockGetMCPTools.mockResolvedValue({ share_file: foreignTool('from-platform') });

    const { tools } = await collectTools({
      userId: 'user-1',
      agentId: 'agent-1',
      mode: 'cron',
      lockedIn: false,
      taskInvoker: vi.fn(),
      postingCeiling: { webChat: true, targets: [] },
    });

    expect(tools.share_file).toBeUndefined();
    expect(tools.send_message).toBeDefined();
    expect((await collect()).share_file).toBeDefined();
  });

  it('offers the platform and plugin tools for deferral, and no built-in', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl_get: foreignTool('from-platform') });
    mockGetPluginTools.mockResolvedValue({ notes__db__query: foreignTool('from-plugin') });

    const { deferrable } = await collectTools({
      userId: 'user-1',
      agentId: 'agent-1',
      mode: 'chat',
      lockedIn: false,
      taskInvoker: vi.fn(),
    });

    expect(deferrable.sort()).toEqual(['kubectl_get', 'notes__db__query']);
  });

  it('still registers a platform tool whose name nothing else claims', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl_get: foreignTool('from-platform') });

    const tools = await collect();

    expect(tools.kubectl_get.description).toBe('from-platform');
  });
});

/**
 * `share_file` reads a path the shell tools wrote, so the two must resolve a
 * relative path against the same root. They did not: `getShareFileTools()` was
 * called with no argument and fell back to the global root while the shell tools
 * used the thread's — so in a thread with its own workspace the agent wrote a file
 * and sharing it reported "File not found". The write/read sequencing compares
 * resolved paths, so it depends on this too.
 */
describe('collectTools workspace root', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubagents.mockResolvedValue([]);
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
  });

  it('gives share_file the same per-thread workspace root as the shell tools', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-ws-'));
    const original = process.env.SHELL_WORKSPACE_ROOT;
    // A global root that is deliberately not the thread's, so a fallback shows up
    // as a miss rather than passing by coincidence.
    process.env.SHELL_WORKSPACE_ROOT = path.join(workspaceRoot, 'elsewhere');
    // Only the path resolution is under test here; persistence has its own suite.
    const createSpy = vi
      .spyOn(attachmentService, 'create')
      .mockImplementation(async (input) => ({ id: 'att-1', ...input }) as never);

    try {
      const { tools } = await collectTools({
        userId: 'user-1',
        agentId: 'agent-1',
        mode: 'chat',
        lockedIn: false,
        taskInvoker: vi.fn(),
        workspaceRoot,
      });

      const write = tools.shell_write_file as never as {
        execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
      };
      const share = tools.share_file as never as {
        execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
      };

      await write.execute({ path: 'report.txt', content: 'body\n' }, { toolCallId: 'w' });
      const shared = (await share.execute({ path: 'report.txt' }, { toolCallId: 's' })) as {
        success: boolean;
        error?: string;
      };

      expect(shared.error).toBeUndefined();
      expect(shared.success).toBe(true);
    } finally {
      createSpy.mockRestore();
      if (original === undefined) delete process.env.SHELL_WORKSPACE_ROOT;
      else process.env.SHELL_WORKSPACE_ROOT = original;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('computer tool modes', () => {
  beforeEach(() => {
    mockGetSubagents.mockResolvedValue([]);
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
  });

  it.each(['meeting', 'subagent'])('omits desktop tools from %s', async (mode) => {
    const { tools } = await collectTools({ userId: 'user', agentId: 'agent', mode, lockedIn: false, taskInvoker: vi.fn() });
    expect(Object.keys(tools).filter((name) => name.startsWith('computer_'))).toEqual([]);
  });

  it.each(['chat', 'goal', 'cron', 'heartbeat', 'webhook'])('keeps stable desktop declarations in %s without an execution context', async (mode) => {
    const { tools } = await collectTools({ userId: 'user', agentId: 'agent', mode, lockedIn: false, taskInvoker: vi.fn() });
    expect(tools.computer_browse).toBeDefined();
    expect(tools.computer_help).toBeDefined();
  });
});

describe('compacted-history tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubagents.mockResolvedValue([]);
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
  });

  const collect = (threadId?: string) =>
    collectTools({ userId: 'user-1', agentId: 'agent-1', threadId, mode: 'chat', lockedIn: false, taskInvoker: vi.fn() });

  it('is offered on a stored thread', async () => {
    mockGetThreadSource.mockResolvedValue('DATABASE');
    expect((await collect('thread-1')).tools).toHaveProperty('read_compacted_history');
  });

  it('is not offered on a thread read live from a channel, whose messages stay there', async () => {
    mockGetThreadSource.mockResolvedValue('SLACK');
    expect((await collect('thread-1')).tools).not.toHaveProperty('read_compacted_history');
  });

  it('is not offered to a run without a thread', async () => {
    expect((await collect()).tools).not.toHaveProperty('read_compacted_history');
  });
});

describe('collectTools coding agent sign-in', () => {
  beforeEach(() => {
    mockGetSubagents.mockResolvedValue([]);
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
  });

  it('offers the sign-in in a chat, where a person is there to sign in', async () => {
    const { tools } = await collectTools({ userId: 'user', agentId: 'agent', mode: 'chat', threadId: 'thread-1', lockedIn: false, taskInvoker: vi.fn() });
    expect(tools.coding_agent_sign_in).toBeDefined();
  });

  it.each(['heartbeat', 'cron', 'webhook', 'goal', 'meeting', 'subagent'])('offers no sign-in in %s', async (mode) => {
    const { tools } = await collectTools({ userId: 'user', agentId: 'agent', mode, threadId: 'thread-1', lockedIn: false, taskInvoker: vi.fn() });
    expect(tools.coding_agent_sign_in).toBeUndefined();
  });
});
