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
use serde_json::json;

use super::engine::{EngineCallOptions, engine_call, engine_call_args, engine_failure};
use super::volumes::{CONTAINER_PATHS, volume_mounts};
use crate::config::CONFIG;
use crate::lib::execution_environments::capture::CaptureResult;
use crate::lib::telemetry::track_event;
use crate::support::now_ms;
use crate::{log_info, log_warn};

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
    let started_at = now_ms();
    ensure_image(&spec.image, spec.refresh_image).await?;
    // A container from a previous run holds the name, so it is removed rather
    // than reused: its mounts were fixed at *its* create. The volumes it was
    // using are untouched and the new container picks the same ones back up.
    remove_container(&spec.name).await;

    let mounts = volume_mounts(&spec.deployment);

    let (uid, gid) = runtime_user();
    let user = format!("{uid}:{gid}");
    let home = format!("HOME={}", CONTAINER_PATHS.home_dir);
    let mut argv: Vec<String> = [
        "run",
        "--detach",
        "--name",
        spec.name.as_str(),
        // The runtime's own user, so a file the agent creates in a volume is owned
        // by whoever will read it back through the engine. A fresh volume takes
        // the mode of the image's directory, which `Dockerfile.exec` makes
        // world-writable for exactly this reason.
        "--user",
        user.as_str(),
        "--workdir",
        CONTAINER_PATHS.workspace_root,
        // Only what the container itself needs. A command's own env, credentials
        // included, is passed on each `docker exec`, so `docker inspect` shows none
        // of it in the container's config.
        "--env",
        home.as_str(),
    ]
    .map(str::to_string)
    .to_vec();
    for mount in &mounts {
        argv.push("--volume".to_string());
        argv.push(format!("{}:{}", mount.name, mount.path));
    }
    // Held open by the image's own command; nothing runs here until a
    // `docker exec` arrives.
    argv.extend([
        spec.image.clone(),
        "sleep".to_string(),
        "infinity".to_string(),
    ]);

    let run = engine_call(
        &argv,
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    if run.error.is_some() || run.exit_code != Some(0) {
        let mut props = event_props(&spec.image);
        props.insert("status".to_string(), "failed".to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (now_ms() - started_at).to_string(),
        );
        track_event(
            "exec container started",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
        anyhow::bail!(engine_failure("could not start the exec container", &run));
    }
    let names: Vec<&str> = mounts.iter().map(|mount| mount.name.as_str()).collect();
    log_info!(
        json!({ "container": spec.name, "image": spec.image, "volumes": names }),
        "[Docker] exec container ready"
    );
    let mut props = event_props(&spec.image);
    props.insert("status".to_string(), "ready".to_string());
    props.insert("volumes".to_string(), mounts.len().to_string());
    props.insert(
        "elapsed_ms".to_string(),
        (now_ms() - started_at).to_string(),
    );
    track_event(
        "exec container started",
        Some(&CONFIG.owner_user_id()),
        Some(props),
    );
    Ok(())
}

/// The uid and gid this process runs as (`os.userInfo()`). Windows has none, and
/// Node reports -1 for both there.
fn runtime_user() -> (i64, i64) {
    #[cfg(unix)]
    {
        // SAFETY: both calls only read the process's credentials.
        unsafe { (i64::from(libc::getuid()), i64::from(libc::getgid())) }
    }
    #[cfg(not(unix))]
    {
        (-1, -1)
    }
}

/// Remove the container and leave every volume in place. Never fails: the
/// process is leaving either way. Emits `exec container stopped`.
pub async fn stop_container(name: &str, image: &str) {
    let started_at = now_ms();
    let run = remove_container(name).await;
    let failed = run.error.is_some() || run.exit_code != Some(0);
    if failed {
        log_warn!(
            json!({ "container": name }),
            "{}",
            engine_failure("could not remove the exec container", &run)
        );
    }
    let mut props = event_props(image);
    props.insert(
        "status".to_string(),
        if failed { "failed" } else { "removed" }.to_string(),
    );
    props.insert(
        "elapsed_ms".to_string(),
        (now_ms() - started_at).to_string(),
    );
    track_event(
        "exec container stopped",
        Some(&CONFIG.owner_user_id()),
        Some(props),
    );
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
    let present = engine_call_args(
        &["image", "inspect", image],
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    let held = present.error.is_none() && present.exit_code == Some(0);
    if held && !refresh {
        return Ok(());
    }

    log_info!(json!({ "image": image }), "[Docker] pulling the exec image");
    let pull = engine_call_args(
        &["pull", image],
        EngineCallOptions {
            timeout_ms: PULL_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    if pull.error.is_none() && pull.exit_code == Some(0) {
        return Ok(());
    }
    if !held {
        anyhow::bail!(engine_failure(&format!("could not pull {image}"), &pull));
    }
    log_warn!(
        json!({ "image": image }),
        "{}",
        engine_failure("could not refresh the exec image", &pull)
    );
    Ok(())
}

/// Forced, and with no grace period to ask for: `--time` belongs to `stop`, not
/// `rm`, and passing it makes the engine reject the whole call. Nothing in the
/// container needs to flush anyway — the shutdown that calls this has already
/// killed the agent's own work, and what is left is the `sleep` holding the
/// container open.
async fn remove_container(name: &str) -> CaptureResult {
    engine_call_args(
        &["rm", "--force", name],
        EngineCallOptions {
            timeout_ms: CONTROL_TIMEOUT_MS,
            env: None,
        },
    )
    .await
}
