//! Whether Claude Code has a credential to run with.

use crate::lib::execution_environments::execution_environment::ProcessEnv;

pub use super::environment::claude_code_environment;

/// A key, a token, or a provider switch in the resolved environment; else, as the
/// last resort since it costs a run of the CLI itself, a login saved in the
/// execution environment's Claude home (an unreadable one counts as none).
pub async fn has_claude_code_credentials(env: &ProcessEnv) -> bool {
    todo!()
}
