/**
 * The MCP servers the runtime connects for the agent, as one list a coding
 * agent's adapter can hand to its agent: the Lens Agents endpoint and every
 * server an installed plugin declares.
 */
import { createHash } from 'crypto';
import { config } from '../config';
import { pluginMcpService } from '../services/plugin-mcp.service';
import type { CodingAgentMcpServer } from './coding-agents/coding-agent';
import { getExecutionEnvironment } from './execution-environments/get-execution-environment';
import { sanitizeToolNameSegment } from './tool-names';

/** The name the Lens Agents endpoint has in the list. */
const NEXUS_SERVER_NAME = 'nexus';

/**
 * A plugin's server is named `<plugin id>__<server name>`, sanitized as the
 * agent's own names for its tools are. Sanitizing can map two plugin ids to one
 * name, so a name already taken gets a digest of the server's own ids.
 *
 * A plugin's stdio server runs where the plugin's files are, in the
 * deployment's execution environment, so it is left out for a process rooted
 * in a `workdir` that environment does not serve.
 */
export function agentMcpServers(workdir?: string): CodingAgentMcpServer[] {
  const stdioReachable = !workdir || getExecutionEnvironment().servesPath(workdir);
  const servers: CodingAgentMcpServer[] = config.nexusMcpUrl
    ? [{ kind: 'http', name: NEXUS_SERVER_NAME, url: config.nexusMcpUrl, headers: {} }]
    : [];
  const taken = new Set(servers.map((s) => s.name));
  for (const { pluginId, server } of pluginMcpService.configuredServers()) {
    if (server.kind === 'stdio' && !stdioReachable) continue;
    let name = [pluginId, server.name].map(sanitizeToolNameSegment).join('__');
    if (taken.has(name)) name = `${name}_${digest(`${pluginId}/${server.name}`)}`;
    taken.add(name);
    servers.push({ ...server, name });
  }
  return servers;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 7);
}
