/**
 * Coding-agent selector: `config.codingAgent` (`CODING_AGENT`) names the
 * adapter, and the adapter owns everything about running that agent. One
 * instance per process, so the adapter that prepared the home at boot is the
 * one that runs every task. Adding an agent is one folder beside `claude-code/`
 * plus one entry here; the `Record` makes a name in the config enum without an
 * adapter a compile error.
 */

import { config, type CodingAgentName } from '../../config';
import { createClaudeCodeAgent } from './claude-code/claude-code-agent';
import type { CodingAgent } from './coding-agent';

const FACTORIES: Record<CodingAgentName, () => CodingAgent> = {
  'claude-code': createClaudeCodeAgent,
};

let instance: CodingAgent | null = null;

export function getCodingAgent(): CodingAgent {
  instance ??= FACTORIES[config.codingAgent]();
  return instance;
}
