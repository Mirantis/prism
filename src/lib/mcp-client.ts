/**
 * MCP Client Library
 *
 * Connects the agent runtime to the Lens Agents MCP server (kubectl, GitHub,
 * AWS tools) with the AI SDK's MCP client.
 *
 * Every tool collection uses one client per URL, because a client holds a
 * gateway session and the tools it returns run through that client. Each
 * collection lists the tools again, so a connection added in Lens Agents
 * appears on the next turn. A failed listing replaces the client, which is how
 * an expired session recovers.
 */

import { experimental_createMCPClient as createVercelMCPClient } from '@ai-sdk/mcp';
import { Tool } from 'ai';
import { logger } from '../logger';

type MCPToolSet = Record<string, Tool>;
type MCPClient = Awaited<ReturnType<typeof createVercelMCPClient>>;

/** Bounded because every collection waits on the cached connect: a hung one is dropped and retried. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Bounded so shutdown stays inside the process-level force-exit budget. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface MCPConnectionConfig {
  url: string;
}

/** Keyed by URL. The value is the connect promise, so concurrent first collections share one connect. */
const clients = new Map<string, Promise<MCPClient>>();
/** Set by closeMCPClients(): no connect starts after it. */
let closed = false;

/**
 * The tools of the MCP server at `url`, listed through the cached client.
 *
 * @returns Record of tools, or empty object if connection fails
 */
export async function getMCPTools({ url }: MCPConnectionConfig): Promise<MCPToolSet> {
  const reused = clients.get(url);
  if (reused) {
    try {
      return (await (await reused).tools()) as MCPToolSet;
    } catch (error) {
      logger.warn({ err: error }, `[MCPClient] ${url} failed; connecting again`);
      forget(url, reused);
    }
  }

  const fresh = connect(url);
  try {
    return (await (await fresh).tools()) as MCPToolSet;
  } catch (error) {
    logger.error({ err: error }, `[MCPClient] Failed to connect to ${url}`);
    forget(url, fresh);
    return {};
  }
}

/** Close every cached client, a connect in flight included. Bounded. */
export async function closeMCPClients(): Promise<void> {
  closed = true;
  const pending = [...clients.values()];
  clients.clear();
  if (pending.length === 0) return;

  await Promise.race([
    Promise.allSettled(pending.map((client) => client.then((c) => c.close()))),
    // .unref() so a fast close is not held open by the timer itself.
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
  ]);
}

function connect(url: string): Promise<MCPClient> {
  if (closed) return Promise.reject(new Error('MCP clients are shut down'));
  const existing = clients.get(url);
  if (existing) return existing;

  const pending = createVercelMCPClient({
    transport: { type: 'http', url },
    initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
  });
  clients.set(url, pending);
  return pending;
}

/** Remove a failed client from the cache and close it, which ends its gateway session. */
function forget(url: string, stale: Promise<MCPClient>): void {
  if (clients.get(url) === stale) clients.delete(url);
  void stale.then((client) => client.close()).catch(() => {});
}
