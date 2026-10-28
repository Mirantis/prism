/**
 * MCP Client Tests
 *
 * The module caches one client per URL, so each test loads a fresh copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// The module the agent messaging tool tests share; the getMCPTools tests load fresh copies.
import { isAgentMessagingTool, soleAgentMessagingTool } from './mcp-client';
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
