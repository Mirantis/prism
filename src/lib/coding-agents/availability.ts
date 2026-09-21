/**
 * Which coding agents this deployment can actually run.
 *
 * Each adapter answers for itself against the execution environment, so the
 * question is "does the agent have credentials *there*" rather than on
 * whichever machine the runtime happens to be. That makes the answer async,
 * which is why it is a boot step rather than a config constant: `config.ts` is
 * evaluated at import, long before a second environment could be asked
 * anything.
 *
 * Memoized, so the boot call and the first turn's `collectTools()` share one
 * probe and every later turn is free. That also settles the tool descriptions
 * before the first tools block is built, which the prompt cache needs.
 */

import { config, CODING_AGENTS, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { createClaudeCodeAgent } from './claude-code/claude-code-agent';
import { createCodexAgent } from './codex/codex-agent';
import type { CodingAgent } from './coding-agent';

/**
 * Every adapter, whether or not it is available — the availability check is
 * what this module is about, so `getCodingAgent`'s would be circular.
 */
const FACTORIES: Record<CodingAgentName, () => CodingAgent> = {
  'claude-code': createClaudeCodeAgent,
  codex: createCodexAgent,
};

let probe: Promise<void> | null = null;

/**
 * Fill `config.availableCodingAgents` and `config.codingAgent`, once per
 * process. Every later caller awaits the same settled promise.
 */
export function ensureCodingAgentsDetected(): Promise<void> {
  probe ??= detect().catch((err) => {
    // A failed probe leaves no agent available rather than a wrong one: the
    // `coding_agent` tool then says so, which beats launching a binary that
    // cannot authenticate.
    logger.warn({ err }, '[CodingAgents] credential detection failed; none available');
  });
  return probe;
}

async function detect(): Promise<void> {
  const available: CodingAgentName[] = [];
  for (const name of CODING_AGENTS) {
    if (await FACTORIES[name]().isAvailable(process.env)) available.push(name);
  }
  config.availableCodingAgents = available;
  // An explicit CODING_AGENT is the operator's choice and stands even when its
  // credentials are missing, so the failure names the agent they asked for.
  if (!config.configuredCodingAgent) {
    config.codingAgent = available.includes('claude-code') || !available.includes('codex')
      ? 'claude-code'
      : 'codex';
  }
  logger.info(
    { available, effective: config.codingAgent },
    '[Startup] coding agents detected',
  );
}

/** Test-only: forget the probe so the next call runs it again. */
export function __resetCodingAgentDetectionForTests(): void {
  probe = null;
}
