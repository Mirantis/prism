//! A coding agent's home in the execution environment, linked to the skills
//! the runtime already has.
//!
//! Both adapters want the same two things — the home exists, and `skills`
//! inside it points at the environment's skills dir — so they ask for it here
//! rather than each reaching for a filesystem of its own. The environment
//! decides which filesystem that is.

use super::coding_agent::CodingAgentHome;
use crate::lib::execution_environments::execution_environment::ExecutionEnvironment;

/// Prepare `config_dir`, unless an operator named it.
///
/// A home the operator pointed at is theirs — usually their own `~/.claude` —
/// so nothing is created in it and the answer only reports whether the skills
/// happen to be linked there already. Every other home is the runtime's to set
/// up. `operator_home` is the path they named, if any; it is compared rather
/// than merely tested, since an environment with a filesystem of its own
/// ignores a path that means nothing in it.
///
/// A failed link is reported as `skills_linked: false` rather than an error: a
/// home that is not linked to the skills still runs tasks.
pub async fn prepare_shared_skills_home(
    environment: &dyn ExecutionEnvironment,
    config_dir: &str,
    operator_home: Option<&str>,
) -> anyhow::Result<CodingAgentHome> {
    todo!()
}

/// Whether the link really resolves to the skills dir, rather than merely existing.
async fn points_at(environment: &dyn ExecutionEnvironment, link: &str, target: &str) -> bool {
    todo!()
}
