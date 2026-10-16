import { agentProcesses } from '../../lib/agent-processes';
import { inferenceGate } from '../../lib/inference-gate';

/**
 * The runtime-wide side of a secure takeover: no model call and no agent process while
 * any computer has one open. Each computer holds the guard for its own window, so one
 * computer's window ending leaves another's in force.
 */
const holders = new Set<object>();

export function holdSecureGuard(holder: object): void {
  if (holders.has(holder)) return;
  holders.add(holder);
  if (holders.size > 1) return;
  inferenceGate.hold();
  agentProcesses.suspend();
}

export function releaseSecureGuard(holder: object): void {
  if (!holders.delete(holder) || holders.size > 0) return;
  agentProcesses.resume();
  inferenceGate.free();
}
