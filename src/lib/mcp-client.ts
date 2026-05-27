/**
 * MCP Client Library
 *
 * Uses Vercel AI SDK's MCP support to connect to MCP servers and get tools.
 * Used by the agent runtime to connect to:
 * 1. Backend MCP server (built-in tools: memory, config, cron)
 * 2. Nexus MCP server (kubectl, GitHub, AWS tools)
 */

import { experimental_createMCPClient as createVercelMCPClient } from '@ai-sdk/mcp';
import { Tool } from 'ai';
import { logger } from '../logger';

type MCPToolSet = Record<string, Tool>;

export interface MCPConnectionConfig {
  url: string;
  /** Optional auth token. When unset, no Authorization header is sent. */
  token?: string;
  /** Optional header name for the token (default: Authorization with Bearer prefix) */
  headerName?: string;
  /** Additional headers to send with requests */
  extraHeaders?: Record<string, string>;
}

/**
 * Connect to an MCP server and retrieve its tools.
 *
 * @returns Record of tools, or empty object if connection fails
 */
export async function getMCPTools(config: MCPConnectionConfig): Promise<MCPToolSet> {
  try {
    const headers: Record<string, string> = {
      ...config.extraHeaders,
    };

    if (config.token) {
      if (config.headerName) {
        headers[config.headerName] = config.token;
      } else {
        headers['Authorization'] = `Bearer ${config.token}`;
      }
    }

    const client = await createVercelMCPClient({
      transport: {
        type: 'http',
        url: config.url,
        headers,
      },
    });

    const tools = await client.tools();
    return tools as MCPToolSet;
  } catch (error) {
    logger.error({ err: error }, `[MCPClient] Failed to connect to ${config.url}`);
    return {};
  }
}
