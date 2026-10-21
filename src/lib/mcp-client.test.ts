/**
 * MCP Client Tests
 *
 * The module caches one client per URL, so each test loads a fresh copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('closes a client whose session expired and connects again in the same collection', async () => {
    const stale = fakeClient();
    const replacement = fakeClient(async () => ({ kubectl_get: { description: 'Get' } }));
    mockCreateMCPClient.mockResolvedValueOnce(stale).mockResolvedValueOnce(replacement);
    const { getMCPTools } = await load();
    await getMCPTools({ url: MCP_URL });
    stale.tools.mockRejectedValueOnce(sessionExpired());

    const tools = await getMCPTools({ url: MCP_URL });

    expect(tools).toHaveProperty('kubectl_get');
    expect(stale.close).toHaveBeenCalledTimes(1);
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
    stale.tools.mockRejectedValue(sessionExpired());

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

  it('returns empty object when the reconnect after a failed listing also fails', async () => {
    const stale = fakeClient();
    mockCreateMCPClient
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error('Connection refused'));
    const { getMCPTools } = await load();
    await getMCPTools({ url: MCP_URL });
    stale.tools.mockRejectedValueOnce(sessionExpired());

    expect(await getMCPTools({ url: MCP_URL })).toEqual({});
    expect(stale.close).toHaveBeenCalledTimes(1);
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
