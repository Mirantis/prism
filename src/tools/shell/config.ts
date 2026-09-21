/**
 * Shared limits for the shell tools.
 *
 * Where a command runs and what filesystem it sees is the execution
 * environment's (`lib/execution-environments/`); these are the caps the tools
 * apply on top of it.
 */

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 1_200_000; // 20 minutes
/** Max captured stdout / stderr per exec — matches upstream's 10 MiB cap. */
export const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Human-readable label for `MAX_EXEC_OUTPUT_BYTES`. Keep paired with it. */
export const MAX_EXEC_OUTPUT_LIMIT = '10 MiB';
/** Default per-stream output cap when the caller doesn't pass `limit`. */
export const DEFAULT_EXEC_OUTPUT_LIMIT_BYTES = 10000;
