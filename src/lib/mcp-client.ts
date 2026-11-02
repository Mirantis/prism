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
import { toModelToolName } from './tool-names';

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
    return listed(await client.tools());
  } catch (error) {
    logger.warn({ err: error }, `[MCPClient] Listing tools at ${url} failed; connecting again`);
    uncache(url, cached);
  }

  const fresh = connect(url);
  try {
    return listed(await (await fresh).tools());
  } catch (error) {
    logger.error({ err: error }, `[MCPClient] Failed to connect to ${url}`);
    uncache(url, fresh);
    return {};
  }
}

/** A listing's tools, once the names of its agent messaging tools are kept. */
function listed(tools: object): MCPToolSet {
  noteAgentMessagingTools(Object.keys(tools));
  return tools as MCPToolSet;
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

/**
 * The platform's tool for messaging other agents, by the last `__` segment of
 * its name: the runtime keeps the conversation each call starts
 * (`agent-conversation.service.ts`).
 */
const AGENT_MESSAGING_TOOLS: ReadonlySet<string> = new Set(['message_agent']);

/**
 * The agent messaging tool each name the model was shown stands for, from the
 * listings so far. The tools block shortens a name past 64 characters
 * (`toModelToolName`), and a long prefix such as `<uuid>__<server>__` costs the
 * name its last segment, so the name a call was recorded under can't be read
 * for the tool.
 */
const agentMessagingToolByModelName = new Map<string, string>();

/** Keep the name the model is shown for each agent messaging tool in a listing. */
export function noteAgentMessagingTools(names: Iterable<string>): void {
  for (const name of names) {
    const tool = name.split('__').at(-1);
    if (tool && AGENT_MESSAGING_TOOLS.has(tool)) agentMessagingToolByModelName.set(toModelToolName(name), tool);
  }
}

/**
 * Whether `name` is the agent messaging tool `tool`, by the name the endpoint
 * gives it or by the one the model was shown. The endpoint may put prefixes of
 * its own in front, such as the server's name, so only the last `__` segment of
 * its name is compared.
 */
export function isAgentMessagingTool(name: string, tool: string): boolean {
  if (name.split('__').at(-1) === tool) return true;
  return agentMessagingToolByModelName.get(name) === tool;
}

/**
 * The one name in `names` that is the agent messaging tool `tool`, or null when
 * none is or more than one is. Only the last segment of a name says which tool it
 * is, so any server on the endpoint can offer one that matches. With two, the
 * runtime can't tell the platform's own from another server's, and trusting
 * either would let that server decide which conversations are kept, so it uses
 * neither.
 */
export function soleAgentMessagingTool(names: Iterable<string>, tool: string): string | null {
  const matches = [...names].filter((name) => isAgentMessagingTool(name, tool));
  if (matches.length > 1) {
    logger.warn({ tool, matches }, '[MCPClient] More than one tool is an agent messaging tool; using none of them');
    return null;
  }
  return matches[0] ?? null;
}
