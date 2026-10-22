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
import { config } from '../config';
import { logger } from '../logger';

type MCPToolSet = Record<string, Tool>;
type MCPClient = Awaited<ReturnType<typeof createVercelMCPClient>>;

/** Bounded because every collection waits on the cached connect: a hung one leaves the cache. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Bounded so a slow gateway does not hold up shutdown. */
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
 * A failed listing removes the client from the cache and connects once more.
 * That client stays open, because tools another turn already holds, such as a
 * meeting's, run through it.
 *
 * @returns Record of tools, or empty object if connection fails
 */
export async function getMCPTools({ url }: MCPConnectionConfig): Promise<MCPToolSet> {
  if (closed) return {};
  const cached = connect(url);
  let client: MCPClient;
  try {
    client = await cached;
  } catch (error) {
    logger.error({ err: error }, `[MCPClient] Failed to connect to ${url}`);
    return {};
  }

  try {
    return (await client.tools()) as MCPToolSet;
  } catch (error) {
    logger.warn({ err: error }, `[MCPClient] Listing tools at ${url} failed; connecting again`);
    uncache(url, cached);
  }

  const fresh = connect(url);
  try {
    return (await (await fresh).tools()) as MCPToolSet;
  } catch (error) {
    logger.error({ err: error }, `[MCPClient] Failed to connect to ${url}`);
    uncache(url, fresh);
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
  // A failed connect leaves the cache, so the next collection connects again.
  pending.catch(() => uncache(url, pending));
  return pending;
}

function uncache(url: string, stale: Promise<MCPClient>): void {
  if (clients.get(url) === stale) clients.delete(url);
}

/** How long a listing without `list_agents` holds before the endpoint is asked again. */
const LIST_AGENTS_ABSENT_RECHECK_MS = 10 * 60_000;

/** The name the Lens Agents MCP endpoint gives `list_agents`, once a listing found it. */
let listAgentsToolName: string | null = null;
let listAgentsAbsentAt = Number.NEGATIVE_INFINITY;

/**
 * Whether `name` is `tool` of the `lens-agents-client` server. The endpoint puts
 * a prefix of its own in front, so only the last two `__` segments are compared,
 * and on the name the server gives, which the tools block may shorten.
 */
export function isLensAgentsClientTool(name: string, tool: string): boolean {
  const segments = name.split('__');
  return segments.at(-2) === 'lens-agents-client' && segments.at(-1) === tool;
}

/** The first text part of a tool's result. */
function resultText(result: Awaited<ReturnType<MCPClient['callTool']>>): string | undefined {
  const content: unknown = 'content' in result ? result.content : undefined;
  if (!Array.isArray(content)) return undefined;
  const part = content.find((item) => item?.type === 'text');
  return typeof part?.text === 'string' ? part.text : undefined;
}

async function findListAgentsTool(client: MCPClient, signal: AbortSignal): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const page = await client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
      options: { signal },
    });
    const found = page.tools.find((tool) => isLensAgentsClientTool(tool.name, 'list_agents'));
    if (found) return found.name;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

/**
 * Call `list_agents` on the Lens Agents MCP endpoint as the runtime itself, not
 * as the model, and answer the text of its result. Null when `NEXUS_MCP_URL` is
 * unset or the endpoint has no such tool. A failed call throws.
 */
export async function callListAgents(args: Record<string, unknown>, signal: AbortSignal): Promise<string | null> {
  const url = config.nexusMcpUrl;
  if (!url) return null;
  if (!listAgentsToolName && Date.now() - listAgentsAbsentAt < LIST_AGENTS_ABSENT_RECHECK_MS) return null;

  const client = await createVercelMCPClient({
    transport: { type: 'http', url },
    initializationOptions: { signal },
  });
  try {
    const name = listAgentsToolName ?? (await findListAgentsTool(client, signal));
    if (!name) {
      listAgentsAbsentAt = Date.now();
      return null;
    }
    listAgentsToolName = name;
    const result = await client.callTool({ name, arguments: args, options: { signal } }).catch((error: unknown) => {
      // The tool may be gone since it was found; the next call lists the tools again.
      listAgentsToolName = null;
      throw error;
    });
    const text = resultText(result);
    if (result.isError || text === undefined) {
      throw new Error(`list_agents answered ${result.isError ? 'an error' : 'no text'}`);
    }
    return text;
  } finally {
    // Not awaited: closing can send a DELETE for the session, which takes no
    // signal, and the turn waits for this call. A slow one ends on its own.
    void client.close().catch((err: unknown) => logger.debug({ err }, '[MCPClient] Closing the list_agents client failed'));
  }
}

/** Forget what the listings found, as a restart would. For tests. */
export function resetListAgentsToolForTests(): void {
  listAgentsToolName = null;
  listAgentsAbsentAt = Number.NEGATIVE_INFINITY;
}
