//! The exec container's lifetime, which is the runtime's — and the volumes',
//! which is longer.
//!
//! The container is created at boot, runs the whole time and is removed at
//! shutdown, so a `shell_spawn` background process and a long `coding_agent`
//! task live between turns exactly as they do when they are children of the
//! runtime. The volumes it mounts are never removed: they hold the workspace,
//! the skills, the plugins and both coding agents' logins, and losing them on a
//! restart would lose the agent's work.

use indexmap::IndexMap;

use crate::lib::execution_environments::capture::CaptureResult;

/// Pulling an image over a slow link is the one step that can take minutes.
pub const PULL_TIMEOUT_MS: u64 = 10 * 60_000;
pub const CONTROL_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerSpec {
    pub name: String,
    pub image: String,
    /// The tag is republished, so the engine's cached copy of it can be stale.
    pub refresh_image: bool,
    /// Names the volumes after the deployment, so two runtimes never share one.
    pub deployment: String,
}

/// Bring the container up, replacing one a crashed run left behind. Fails with
/// the engine's own words when it cannot, which the selector turns into a fall
/// back to the local environment.
///
/// `docker run --detach --name <name> --user <uid>:<gid> --workdir <workspace>
/// --env HOME=<home> --volume <name>:<path>… <image> sleep infinity`, with the
/// `exec container started` event (`status` `ready` or `failed`).
pub async fn start_container(spec: &ContainerSpec) -> anyhow::Result<()> {
    todo!()
}

/// Remove the container and leave every volume in place. Never fails: the
/// process is leaving either way. Emits `exec container stopped`.
pub async fn stop_container(name: &str, image: &str) {
    todo!()
}

/// No container name: it is derived from the data dir, which is a host path.
fn event_props(image: &str) -> IndexMap<String, String> {
    IndexMap::from([
        ("execution.environment".to_string(), "docker".to_string()),
        ("execution.image".to_string(), image.to_string()),
    ])
}

/// Make sure the engine holds the image, and hold the right one.
///
/// A version tag names one build for good, so having it is enough and a pull on
/// every boot would only make an offline start fail for an image sitting right
/// there. A republished tag is the other way round: the copy the engine cached
/// on some earlier boot can be months behind the runtime asking for it, so it
/// is pulled again each time. That pull may fail — a registry that is down, a
/// machine that is offline — and a copy that works is better than no start at
/// all, so the failure is logged and the cached image is used.
async fn ensure_image(image: &str, refresh: bool) -> anyhow::Result<()> {
    todo!()
}

/// Forced, and with no grace period to ask for: `--time` belongs to `stop`, not
/// `rm`, and passing it makes the engine reject the whole call. Nothing in the
/// container needs to flush anyway — the shutdown that calls this has already
/// killed the agent's own work, and what is left is the `sleep` holding the
/// container open.
async fn remove_container(name: &str) -> CaptureResult {
    todo!()
}
