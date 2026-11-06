//! Moving the agent's files when the deployment changes where commands run.
//!
//! The two environments keep the agent's storage in different places: one uses
//! directories on this machine, the other named volumes the engine owns.
//! Installing a container engine, or setting `EXECUTION_ENVIRONMENT`, therefore
//! moves the agent to storage that starts out empty — its skills, its plugins,
//! its workspace and both coding-agent logins would appear to be gone, with the
//! originals sitting untouched on the side it came from.
//!
//! So a boot that finds the environment changed copies the agent's files across
//! first. The database is not involved: it is the runtime's own and stays on
//! this machine under either environment, which is why memory, threads and the
//! identity documents survive the switch on their own.
//!
//! **Nothing is overwritten.** Only an entry the destination does not already
//! have is copied, so switching back and forth merges rather than clobbers: work
//! done on one side arrives on the other, and work already there is left alone.
//! The cost is that an entry edited on both sides keeps the destination's copy,
//! which is the safe way round — the other one is still where it was.

use std::sync::Arc;

use serde::Serialize;

use super::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
};

/// What moves. The saved tool outputs and the container's `$HOME` are left out:
/// both are caches with their own expiry, and copying them would move stale
/// bytes the agent never asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migrated {
    Workspace,
    Skills,
    Plugins,
    PluginData,
    ClaudeHome,
    CodexHome,
}

impl Migrated {
    pub fn as_str(self) -> &'static str {
        match self {
            Migrated::Workspace => "workspace",
            Migrated::Skills => "skills",
            Migrated::Plugins => "plugins",
            Migrated::PluginData => "plugin data",
            Migrated::ClaudeHome => "claude home",
            Migrated::CodexHome => "codex home",
        }
    }
}

pub const MIGRATED: [Migrated; 6] = [
    Migrated::Workspace,
    Migrated::Skills,
    Migrated::Plugins,
    Migrated::PluginData,
    Migrated::ClaudeHome,
    Migrated::CodexHome,
];

/// Logged as the fields of `[Startup] moved the agent's files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MigrationReport {
    pub from: ExecutionEnvironmentName,
    pub to: ExecutionEnvironmentName,
    pub copied: i64,
    pub skipped: i64,
    pub failures: i64,
}

/// Record the environment this run uses, and move the agent's files first when
/// the last run used the other one.
///
/// Never fails: a failed entry is removed from the target, so both sides are as
/// they were for it, and an agent that boots without its skills is better than
/// one that does not boot. The stored environment advances only once every entry
/// has landed, so the next boot tries the rest again.
pub async fn migrate_storage_if_environment_changed() -> Option<MigrationReport> {
    todo!()
}

/// Store the environment in `runtime_state`; a failure is logged
/// (`[Startup] could not record the execution environment`) and not fatal.
async fn remember(current: ExecutionEnvironmentName) {
    todo!()
}

async fn migrate(
    previous: ExecutionEnvironmentName,
    current: ExecutionEnvironmentName,
) -> anyhow::Result<MigrationReport> {
    todo!()
}

/// One side of a copy, over whichever filesystem holds it.
struct Side {
    path: String,
    files: Arc<dyn ExecutionFiles>,
}

/// Copy every entry of `source` the target lacks, counting it in `report`, and
/// remove a partial copy when one fails.
async fn move_entries(
    what: Migrated,
    into_container: bool,
    container: &str,
    source: Side,
    target: Side,
    report: &mut MigrationReport,
) {
    todo!()
}

/// The directory each kind lives in, for one environment.
///
/// On this machine a coding agent's home is always the runtime's own one under
/// the data dir. An operator's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` usually names
/// their real `~/.claude` or `~/.codex`, and copying that into the agent's volume
/// would hand the agent's shell the operator's sessions and credentials.
fn directory_of(environment: &dyn ExecutionEnvironment, what: Migrated) -> String {
    todo!()
}
