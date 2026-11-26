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
    let skills_dir = environment.paths().skills_dir;
    let files = environment.files();
    let link = format!("{config_dir}/skills");

    if operator_home.is_some_and(|home| !home.is_empty() && home == config_dir) {
        return Ok(CodingAgentHome {
            config_dir: config_dir.to_string(),
            skills_linked: points_at(environment, &link, &skills_dir).await,
        });
    }

    files.mkdir(config_dir).await?;
    if files.symlink(&skills_dir, &link).await.is_err() {
        // A home that is not linked to the skills still runs tasks, so this is
        // reported rather than returned; the startup log carries `skills_linked`.
        return Ok(CodingAgentHome {
            config_dir: config_dir.to_string(),
            skills_linked: false,
        });
    }
    Ok(CodingAgentHome {
        config_dir: config_dir.to_string(),
        skills_linked: points_at(environment, &link, &skills_dir).await,
    })
}

/// Whether the link really resolves to the skills dir, rather than merely existing.
pub(crate) async fn points_at(
    environment: &dyn ExecutionEnvironment,
    link: &str,
    target: &str,
) -> bool {
    let files = environment.files();
    let (from, to) = tokio::join!(files.realpath(link), files.realpath(target));
    match (from, to) {
        (Ok(from), Ok(to)) => from == to,
        _ => false,
    }
}
