/**
 * MCP Client Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateMCPClient } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({
  experimental_createMCPClient: mockCreateMCPClient,
}));

import { getMCPTools } from './mcp-client';

describe('getMCPTools', () => {
  const toolSet = {
    memory_search: { description: 'Search memory' },
    memory_write: { description: 'Write memory' },
  };

  beforeEach(() => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue(toolSet),
    });
  });

  it('returns tools from MCP server on success', async () => {
    const tools = await getMCPTools({
      url: 'http://localhost:3001/mcp',
      token: 'test-token',
    });

    expect(tools).toHaveProperty('memory_search');
    expect(tools).toHaveProperty('memory_write');
  });

  it('uses Authorization: Bearer header by default', async () => {
    await getMCPTools({
      url: 'http://localhost:3001/mcp',
      token: 'my-secret',
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3001/mcp',
        headers: { Authorization: 'Bearer my-secret' },
      },
    });
  });

  it('uses custom header when headerName is specified', async () => {
    await getMCPTools({
      url: 'http://localhost:3001/mcp',
      token: 'my-secret',
      headerName: 'X-Custom-Auth',
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3001/mcp',
        headers: { 'X-Custom-Auth': 'my-secret' },
      },
    });
  });

  it('merges extraHeaders into transport headers', async () => {
    await getMCPTools({
      url: 'http://localhost:3001/mcp',
      token: 'my-secret',
      extraHeaders: { 'x-mcp-tools': 'shell_exec,list_clusters' },
    });

    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:3001/mcp',
        headers: {
          Authorization: 'Bearer my-secret',
          'x-mcp-tools': 'shell_exec,list_clusters',
        },
      },
    });
  });

  it('returns empty object on connection failure', async () => {
    mockCreateMCPClient.mockRejectedValueOnce(new Error('Connection refused'));

    const tools = await getMCPTools({
      url: 'http://localhost:9999/mcp',
      token: 'test-token',
    });

    expect(tools).toEqual({});
  });
});
