//! Reaching the agent's volumes to copy files in or out.
//!
//! `docker cp` addresses a container, not a volume, so moving files needs one
//! to exist. When the runtime is serving commands there is one already. When it
//! is not — the deployment has moved back to running on this machine, and the
//! volumes still hold the work — a container is created for the copy and
//! removed afterwards.

use serde_json::json;

use super::docker_environment::exec_image;
use super::engine::{EngineCallOptions, engine_call, engine_call_args, engine_failure};
use super::volumes::volume_mounts;
use crate::config::CONFIG;
use crate::log_info;
use crate::support::js;

pub const CONTROL_TIMEOUT_MS: u64 = 60_000;

/// A large workspace crossing the engine's pipe is the slow case.
pub const COPY_TIMEOUT_MS: u64 = 30 * 60_000;

/// A container the volumes are mounted in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerAccess {
    pub container: String,
    /// The container this call created (`<container>-copy`), which `release`
    /// removes; `None` when it reused the running exec container.
    temporary: Option<String>,
}

impl DockerAccess {
    /// Removes the container when this call created one; otherwise does nothing.
    pub async fn release(&self) -> anyhow::Result<()> {
        if let Some(temporary) = &self.temporary {
            remove_container(temporary).await;
        }
        Ok(())
    }
}

/// A container the volumes are mounted in, for as long as the caller needs one.
///
/// Reuses the running exec container when it is there, so a copy never disturbs
/// work in progress.
pub async fn open_volumes(deployment: &str, container: &str) -> anyhow::Result<DockerAccess> {
    if is_running(container).await {
        return Ok(DockerAccess {
            container: container.to_string(),
            temporary: None,
        });
    }

    let temporary = format!("{container}-copy");
    remove_container(&temporary).await;

    let image = exec_image(&CONFIG.app_version);
    let mut argv: Vec<String> = ["run", "--detach", "--name", temporary.as_str()]
        .map(str::to_string)
        .to_vec();
    for mount in volume_mounts(deployment) {
        argv.push("--volume".to_string());
        argv.push(format!("{}:{}", mount.name, mount.path));
    }
    argv.extend([image, "sleep".to_string(), "infinity".to_string()]);
    let run = engine_call(
        &argv,
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    if run.error.is_some() || run.exit_code != Some(0) {
        anyhow::bail!(engine_failure("could not open the agent volumes", &run));
    }
    log_info!(
        json!({ "container": temporary }),
        "[Docker] opened the volumes for a copy"
    );

    Ok(DockerAccess {
        container: temporary.clone(),
        temporary: Some(temporary),
    })
}

/// Copy one entry from this machine into the container.
pub async fn copy_into_container(container: &str, from: &str, to: &str) -> anyhow::Result<()> {
    copy(from, &format!("{container}:{to}")).await
}

/// Copy one entry out of the container onto this machine.
pub async fn copy_from_container(container: &str, from: &str, to: &str) -> anyhow::Result<()> {
    copy(&format!("{container}:{from}"), to).await
}

/// `docker cp --archive`. It names the destination in full rather than a
/// directory to drop into: given an existing directory the engine copies
/// *inside* it, which would nest a second copy on a re-run.
async fn copy(from: &str, to: &str) -> anyhow::Result<()> {
    let run = engine_call_args(
        &["cp", "--archive", from, to],
        EngineCallOptions {
            timeout_ms: COPY_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    if run.error.is_some() || run.exit_code != Some(0) {
        anyhow::bail!(engine_failure(
            &format!("could not copy {from} to {to}"),
            &run
        ));
    }
    Ok(())
}

async fn is_running(container: &str) -> bool {
    let run = engine_call_args(
        &["inspect", "--format", "{{.State.Running}}", container],
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    run.error.is_none() && run.exit_code == Some(0) && js::trim(&run.stdout) == "true"
}

async fn remove_container(name: &str) {
    engine_call_args(
        &["rm", "--force", name],
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
}
