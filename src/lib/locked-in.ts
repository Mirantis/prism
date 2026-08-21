/**
 * Locked-in mode refusals, shared by every tool the lock covers.
 *
 * Kept out of the tool modules so the workspace-markdown writers
 * (`src/tools/agent-config.ts`) and the long-term memory writers
 * (`src/tools/memory.ts`) return the same shape and emit the same one event.
 */

import { trackEvent } from './telemetry';

/** Fields the lock protects, as they are named in the database. */
export type LockedField =
  | 'soulMd'
  | 'memoryMd'
  | 'userMd'
  | 'heartbeatMd'
  | 'visionMd'
  | 'bootstrapMd'
  | 'memoryEntry';

/**
 * Refusal returned to the model when a workspace-markdown write is attempted
 * while locked-in mode is on.
 */
const LOCKED_IN_WORKSPACE_REFUSAL =
  'Locked-in mode is on, so your workspace files are read-only and this change was not saved. ' +
  'Tell the user what you would have changed and that they can turn locked-in mode off in their agent settings.';

/**
 * Refusal for the long-term memory writers. Separate text because those tools
 * write vector-memory entries, not workspace files, and a message about files
 * would send the model looking for a file to edit instead.
 */
const LOCKED_IN_MEMORY_REFUSAL =
  'Locked-in mode is on, so your long-term memory is read-only and this change was not saved. ' +
  'You can still search memory. Tell the user what you would have remembered or removed and that ' +
  'they can turn locked-in mode off in their agent settings.';

/**
 * The one emitter for the refused-write event, so a refusal is never
 * double-counted.
 */
export function refuseLockedWrite(
  agentId: string,
  field: LockedField,
): { success: false; error: string } {
  trackEvent('agent locked write refused', null, {
    'agent.id': agentId,
    'config.field': field,
  });
  return {
    success: false,
    error: field === 'memoryEntry' ? LOCKED_IN_MEMORY_REFUSAL : LOCKED_IN_WORKSPACE_REFUSAL,
  };
}
