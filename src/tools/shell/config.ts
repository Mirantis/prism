/**
 * Shared constants for the shell tools.
 *
 * `workspaceRoot` mirrors upstream's `/home/sandbox` concept — the
 * default cwd for commands and the base used to resolve relative
 * paths. The agent can still hand absolute paths to any tool; those
 * bypass the workspace and are governed by filesystem permissions,
 * matching upstream's contract.
 */
import * as path from 'path';

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 1_200_000; // 20 minutes
/** Max captured stdout / stderr per exec — matches upstream's 10 MiB cap. */
export const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Human-readable label for `MAX_EXEC_OUTPUT_BYTES`. Keep paired with it. */
export const MAX_EXEC_OUTPUT_LIMIT = '10 MiB';
/** Default per-stream output cap when the caller doesn't pass `limit`. */
export const DEFAULT_EXEC_OUTPUT_LIMIT_BYTES = 10000;

export function resolveWorkspaceRoot(): string {
  return path.resolve(process.env.SHELL_WORKSPACE_ROOT || '/home/node');
}
