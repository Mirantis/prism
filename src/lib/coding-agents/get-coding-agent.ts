/** One adapter instance per available agent, shared by startup and task execution. */

import { config, type CodingAgentName } from '../../config';
import { createClaudeCodeAgent } from './claude-code/claude-code-agent';
import { createCodexAgent } from './codex/codex-agent';
import type { CodingAgent } from './coding-agent';

const FACTORIES: Record<CodingAgentName, () => CodingAgent> = {
  'claude-code': createClaudeCodeAgent,
  codex: createCodexAgent,
};

const instances = new Map<CodingAgentName, CodingAgent>();

export function getCodingAgent(name: CodingAgentName = config.codingAgent): CodingAgent {
  if (!config.availableCodingAgents.includes(name)) {
    throw new Error(`Coding agent "${name}" is unavailable. Available agents: ${config.availableCodingAgents.join(', ') || 'none'}. Configure its credentials or select an available agent.`);
  }
  let agent = instances.get(name);
  if (!agent) {
    agent = FACTORIES[name]();
    instances.set(name, agent);
  }
  return agent;
}
