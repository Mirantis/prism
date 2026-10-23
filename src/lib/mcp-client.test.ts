/**
 * MCP Client Tests
 *
 * The module caches one client per URL, so each test loads a fresh copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../config';
// The module the callListAgents tests share; the getMCPTools tests load fresh copies.
import { callListAgents, isAgentMessagingTool, resetListAgentsToolForTests, soleAgentMessagingTool } from './mcp-client';
import { toModelToolName } from './tool-names';

const { mockCreateMCPClient } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({
  experimental_createMCPClient: mockCreateMCPClient,
}));

type McpClientModule = typeof import('./mcp-client');

const MCP_URL = 'http://localhost:3001/mcp';

const toolSet = {
  memory_search: { description: 'Search memory' },
  memory_write: { description: 'Write memory' },
};

function fakeClient(tools: () => Promise<unknown> = async () => toolSet) {
  return { tools: vi.fn(tools), close: vi.fn(async () => {}) };
}

/** A gateway answer for a session it no longer knows. */
function sessionExpired(): Error {
  return Object.assign(new Error('MCP HTTP Transport Error: POSTing to endpoint (HTTP 404)'), {
    statusCode: 404,
  });
}

async function load(): Promise<McpClientModule> {
  vi.resetModules();
  return import('./mcp-client');
}


describe('callListAgents', () => {
  const RAW_NAME = '0b6e1c2a-5d1f-4c3e-9a7b-2f8d4e6a1c3b__agent-directory__list_agents';
  const signal = new AbortController().signal;
  let client: { listTools: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
    resetListAgentsToolForTests();
    client = {
      listTools: vi.fn(async ({ params }: { params?: { cursor?: string } } = {}) =>
        params?.cursor === 'page-2'
          ? { tools: [{ name: RAW_NAME }] }
          : { tools: [{ name: 'list_agent' }, { name: 'github__list_agents_all' }], nextCursor: 'page-2' },
      ),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: '{"version":"v1","unchanged":true}\nNo change.' }] })),
      close: vi.fn(async () => undefined),
    };
    mockCreateMCPClient.mockResolvedValue(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('finds the tool by the name the endpoint gives it, calls it, and closes the client', async () => {
    const text = await callListAgents({ knownVersion: 'v1' }, signal);

    expect(text).toBe('{"version":"v1","unchanged":true}\nNo change.');
    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: { type: 'http', url: 'http://localhost:3002/mcp' },
      initializationOptions: { signal },
    });
    expect(client.callTool).toHaveBeenCalledWith({ name: RAW_NAME, arguments: { knownVersion: 'v1' }, options: { signal } });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('answers without waiting for the client to close', async () => {
    // Closing can send a DELETE for the session, which takes no signal.
    client.close.mockReturnValue(new Promise<undefined>(() => {}));

    await expect(callListAgents({}, signal)).resolves.toBe('{"version":"v1","unchanged":true}\nNo change.');
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('lists the tools once, then calls the tool it found', async () => {
    await callListAgents({}, signal);
    await callListAgents({}, signal);

    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('answers null without the tool, and lists again only after ten minutes', async () => {
    client.listTools.mockResolvedValue({ tools: [{ name: 'kubectl__get' }] });

    expect(await callListAgents({}, signal)).toBeNull();
    vi.setSystemTime(new Date('2026-10-21T12:09:59.000Z'));
    expect(await callListAgents({}, signal)).toBeNull();
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-21T12:10:00.000Z'));
    await callListAgents({}, signal);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('takes a second list_agents on another page, from another server, as no tool', async () => {
    // Either one could be the platform's; trusting the first would let any server decide the signing keys.
    client.listTools.mockImplementation(async ({ params }: { params?: { cursor?: string } } = {}) =>
      params?.cursor === 'page-2'
        ? { tools: [{ name: RAW_NAME }] }
        : { tools: [{ name: 'other-framework__list_agents' }], nextCursor: 'page-2' },
    );

    expect(await callListAgents({}, signal)).toBeNull();
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('throws when the tool answers an error, and lists the tools again on a failed call', async () => {
    client.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'denied' }] });
    await expect(callListAgents({}, signal)).rejects.toThrow('list_agents answered an error');

    client.callTool.mockRejectedValueOnce(new Error('unknown tool'));
    await expect(callListAgents({}, signal)).rejects.toThrow('unknown tool');
    await callListAgents({}, signal);

    // Listed for the first call, kept after the error answer, listed again after the failed call.
    expect(client.listTools).toHaveBeenCalledTimes(4);
    expect(client.close).toHaveBeenCalledTimes(3);
  });

  it('answers null with no MCP endpoint', async () => {
    const url = config.nexusMcpUrl;
    (config as { nexusMcpUrl: string | null }).nexusMcpUrl = null;
    try {
      expect(await callListAgents({}, signal)).toBeNull();
      expect(mockCreateMCPClient).not.toHaveBeenCalled();
    } finally {
      (config as { nexusMcpUrl: string | null }).nexusMcpUrl = url;
    }
  });
});

describe('getMCPTools', () => {
  beforeEach(() => {
    mockCreateMCPClient.mockReset();
  });

  it('returns tools from MCP server on success', async () => {
    mockCreateMCPClient.mockResolvedValue(fakeClient());
    const { getMCPTools } = await load();

    const tools = await getMCPTools({ url: MCP_URL });

    expect(tools).toHaveProperty('memory_search');
    expect(tools).toHaveProperty('memory_write');
    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: { type: 'http', url: MCP_URL },
      initializationOptions: { timeout: 10_000 },
    });
  });

  it('reuses one client across collections and lists the tools on each', async () => {
    const client = fakeClient();
    mockCreateMCPClient.mockResolvedValue(client);
    const { getMCPTools } = await load();

    await getMCPTools({ url: MCP_URL });
    await getMCPTools({ url: MCP_URL });
    await getMCPTools({ url: MCP_URL });

    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    expect(client.tools).toHaveBeenCalledTimes(3);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('shares one connect between concurrent first collections', async () => {
    let resolve!: (client: unknown) => void;
    mockCreateMCPClient.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getMCPTools } = await load();

    const first = getMCPTools({ url: MCP_URL });
    const second = getMCPTools({ url: MCP_URL });
    resolve(fakeClient());

    expect(await first).toEqual(toolSet);
    expect(await second).toEqual(toolSet);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('replaces a client whose listing failed and keeps it open for the tools other turns hold', async () => {
    const stale = fakeClient();
    const replacement = fakeClient(async () => ({ kubectl_get: { description: 'Get' } }));
    mockCreateMCPClient.mockResolvedValueOnce(stale).mockResolvedValueOnce(replacement);
    const { getMCPTools } = await load();
    await getMCPTools({ url: MCP_URL });
    stale.tools.mockRejectedValueOnce(sessionExpired());

    const tools = await getMCPTools({ url: MCP_URL });

    expect(tools).toHaveProperty('kubectl_get');
    expect(stale.close).not.toHaveBeenCalled();
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);

    await getMCPTools({ url: MCP_URL });
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
    expect(replacement.tools).toHaveBeenCalledTimes(2);
  });

  it('connects once when two concurrent collections fail on one reused client', async () => {
    const stale = fakeClient();
    const replacement = fakeClient();
    mockCreateMCPClient.mockResolvedValueOnce(stale).mockResolvedValueOnce(replacement);
    const { getMCPTools } = await load();
    await getMCPTools({ url: MCP_URL });
    stale.tools.mockRejectedValue(new Error('fetch failed'));

    const results = await Promise.all([getMCPTools({ url: MCP_URL }), getMCPTools({ url: MCP_URL })]);

    expect(results).toEqual([toolSet, toolSet]);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });

  it('returns empty object on connection failure and connects again on the next collection', async () => {
    mockCreateMCPClient
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce(fakeClient());
    const { getMCPTools } = await load();

    expect(await getMCPTools({ url: MCP_URL })).toEqual({});
    expect(await getMCPTools({ url: MCP_URL })).toEqual(toolSet);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });

  it('gives every collection waiting on a failed connect an empty set, with no second connect', async () => {
    let reject!: (error: Error) => void;
    mockCreateMCPClient.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    const { getMCPTools } = await load();

    const waiting = [getMCPTools({ url: MCP_URL }), getMCPTools({ url: MCP_URL })];
    reject(new Error('MCP client initialization timed out after 10000ms'));

    expect(await Promise.all(waiting)).toEqual([{}, {}]);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('returns empty object when the reconnect after a failed listing also fails', async () => {
    const stale = fakeClient();
    mockCreateMCPClient
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error('Connection refused'));
    const { getMCPTools } = await load();
    await getMCPTools({ url: MCP_URL });
    stale.tools.mockRejectedValueOnce(sessionExpired());

    expect(await getMCPTools({ url: MCP_URL })).toEqual({});
  });
});

describe('closeMCPClients', () => {
  beforeEach(() => {
    mockCreateMCPClient.mockReset();
  });

  it('closes the cached client, and no collection connects after it', async () => {
    const client = fakeClient();
    mockCreateMCPClient.mockResolvedValue(client);
    const { getMCPTools, closeMCPClients } = await load();
    await getMCPTools({ url: MCP_URL });

    await closeMCPClients();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(await getMCPTools({ url: MCP_URL })).toEqual({});
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('closes a client whose connect was still in flight', async () => {
    let resolve!: (client: unknown) => void;
    mockCreateMCPClient.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { getMCPTools, closeMCPClients } = await load();
    const collection = getMCPTools({ url: MCP_URL });

    const shutdown = closeMCPClients();
    const client = fakeClient();
    resolve(client);
    await shutdown;
    await collection;

    expect(client.close).toHaveBeenCalled();
  });
});

describe('isAgentMessagingTool', () => {
  it('reads a tool by its last segment, whatever prefix the endpoint gives it', () => {
    expect(isAgentMessagingTool('hub__agent-directory__message_agent', 'message_agent')).toBe(true);
    expect(isAgentMessagingTool('message_agent', 'message_agent')).toBe(true);
    expect(isAgentMessagingTool('hub__agent-directory__message_agent', 'list_agents')).toBe(false);
    expect(isAgentMessagingTool('hub__github__message_agents', 'message_agent')).toBe(false);
    expect(isAgentMessagingTool('hub__message_agent__send', 'message_agent')).toBe(false);
  });

  it('names the one tool in a set that is the tool, and none when two servers offer it', () => {
    expect(soleAgentMessagingTool(['memory_search', 'hub__agent-directory__message_agent'], 'message_agent')).toBe(
      'hub__agent-directory__message_agent',
    );
    expect(soleAgentMessagingTool(['memory_search'], 'message_agent')).toBeNull();
    expect(
      soleAgentMessagingTool(['hub__agent-directory__message_agent', 'hub__other-framework__message_agent'], 'message_agent'),
    ).toBeNull();
  });

  it.each([
    ['a letter', 'a1c3e5f7-2b4d-4f6a-8c0e-1d3f5a7c9e2b'],
    ['a digit', '9e2b4d6f-8a0c-4e2a-b4c6-d8e0f2a4c6e8'],
  ])('knows the name the model is shown for a listed tool whose uuid starts with %s', async (_, uuid) => {
    const serverName = `${uuid}__agent-directory__message_agent`;
    const modelName = toModelToolName(serverName);
    // The tools block shortens the name past the tool's own segment.
    expect(modelName).not.toContain('message_agent');
    const mcp = await load();
    expect(mcp.isAgentMessagingTool(modelName, 'message_agent')).toBe(false);

    mockCreateMCPClient.mockResolvedValueOnce(
      fakeClient(async () => ({ [serverName]: { description: 'Message an agent' }, memory_search: {} })),
    );
    await mcp.getMCPTools({ url: MCP_URL });

    expect(mcp.isAgentMessagingTool(modelName, 'message_agent')).toBe(true);
    expect(mcp.isAgentMessagingTool(modelName, 'list_agents')).toBe(false);
    expect(mcp.isAgentMessagingTool(toModelToolName('memory_search'), 'message_agent')).toBe(false);
  });
});
