//! Where the Claude Code CLI keeps its own state.

use crate::lib::execution_environments::execution_environment::ProcessEnv;
use crate::lib::execution_environments::workspace::path_resolve;

/// Where the Claude Code CLI keeps its own state — sessions, `.claude.json`,
/// and the skills symlink. An operator's `CLAUDE_CONFIG_DIR` wins; otherwise it
/// sits inside the runtime's data dir (`<data dir>/.claude`), so the user's real
/// `~/.claude` is never touched.
///
/// Resolved from the env the CLI will run with rather than read off this
/// process, because the CLI runs in the execution environment and inherits that
/// environment's own variables. `data_dir` defaults to `resolve_data_dir()`.
pub fn resolve_claude_config_dir(env: &ProcessEnv, data_dir: Option<&str>) -> String {
    match data_dir {
        Some(dir) => resolve_claude_config_dir_in(env, dir),
        None => resolve_claude_config_dir_in(env, &crate::lib::data_dir::resolve_data_dir()),
    }
}

/// `resolve_claude_config_dir` with the data dir given.
pub fn resolve_claude_config_dir_in(env: &ProcessEnv, data_dir: &str) -> String {
    match env.get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => path_resolve(dir),
        None => path_resolve(&format!("{data_dir}/.claude")),
    }
}
