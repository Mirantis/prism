//! Reaching the agent's volumes to copy files in or out.
//!
//! `docker cp` addresses a container, not a volume, so moving files needs one
//! to exist. When the runtime is serving commands there is one already. When it
//! is not — the deployment has moved back to running on this machine, and the
//! volumes still hold the work — a container is created for the copy and
//! removed afterwards.

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
        todo!()
    }
}

/// A container the volumes are mounted in, for as long as the caller needs one.
///
/// Reuses the running exec container when it is there, so a copy never disturbs
/// work in progress.
pub async fn open_volumes(deployment: &str, container: &str) -> anyhow::Result<DockerAccess> {
    todo!()
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
    todo!()
}

async fn is_running(container: &str) -> bool {
    todo!()
}

async fn remove_container(name: &str) {
    todo!()
}
