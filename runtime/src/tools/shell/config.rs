//! Shared limits for the shell tools.
//!
//! Where a command runs and what filesystem it sees is the execution
//! environment's (`lib::execution_environments`); these are the caps the tools
//! apply on top of it.

pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;
/// 20 minutes.
pub const MAX_EXEC_TIMEOUT_MS: u64 = 1_200_000;
/// Max captured stdout / stderr per exec — matches upstream's 10 MiB cap.
pub const MAX_EXEC_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
/// Human-readable label for `MAX_EXEC_OUTPUT_BYTES`. Keep paired with it.
pub const MAX_EXEC_OUTPUT_LIMIT: &str = "10 MiB";
/// Default per-stream output cap when the caller doesn't pass `limit`.
pub const DEFAULT_EXEC_OUTPUT_LIMIT_BYTES: usize = 10000;
