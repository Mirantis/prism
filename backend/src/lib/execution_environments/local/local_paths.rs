//! The agent's directories on this machine: the data dir's own layout, which
//! an operator can point elsewhere one variable at a time.

use super::local_env::process_env;
use crate::lib::coding_agents::claude_code::home::resolve_claude_config_dir;
use crate::lib::coding_agents::codex::credentials::resolve_codex_home;
use crate::lib::data_dir::{
    resolve_data_dir, resolve_plugins_dir, resolve_skills_dir, resolve_tool_output_dir,
};
use crate::lib::execution_environments::execution_environment::AgentPaths;

/// Skills, plugins, `<data dir>/plugin-data`, saved tool outputs, and the two
/// coding agents' homes as this process's environment resolves them.
pub fn local_agent_paths() -> AgentPaths {
    let env = process_env();
    AgentPaths {
        skills_dir: resolve_skills_dir(),
        plugins_dir: resolve_plugins_dir(),
        plugin_data_dir: format!("{}/plugin-data", resolve_data_dir()),
        tool_output_dir: resolve_tool_output_dir(),
        claude_home: resolve_claude_config_dir(&env, None),
        codex_home: resolve_codex_home(&env, None),
    }
}
