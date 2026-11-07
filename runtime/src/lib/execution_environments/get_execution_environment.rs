//! The execution environment this deployment runs in, and the one a given path
//! can be served by.
//!
//! Selection is async — it asks a container engine whether it is there — while
//! every caller wants it synchronously, so this follows the shape
//! `lib::coding_agents::availability` already uses: a memoized probe awaited at
//! boot and at the top of `collect_tools()`, and a synchronous accessor that
//! answers `local` until the probe has settled. That is what keeps the
//! existing call sites unchanged, and what guarantees the answer is fixed before
//! the first turn builds a tools block.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, RwLock};
use serde_json::json;
use tokio::sync::OnceCell;

use super::docker::detect::detect_environment;
use super::docker::docker_environment::create_docker_environment;
use crate::lib::log_redaction::err_json;
use crate::{log_info, log_warn};
use super::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
};
use super::local::local_environment::create_local_environment;

pub use super::docker::detect::DetectionDeps;

/// `local` until the probe replaces it, so a caller before boot is never stuck.
static INSTANCE: RwLock<Option<Arc<dyn ExecutionEnvironment>>> = RwLock::new(None);

/// The settled probe. A failure is kept, so every later caller gets the same one.
static PROBE: LazyLock<Mutex<Arc<OnceCell<Result<(), Arc<anyhow::Error>>>>>> =
    LazyLock::new(|| Mutex::new(Arc::new(OnceCell::new())));

/// One local environment for every fallback, so they share its state.
static FALLBACK: RwLock<Option<Arc<dyn ExecutionEnvironment>>> = RwLock::new(None);

/// Said once per path: a turn makes many calls, and this is a property of the thread.
static REPORTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The factory for each environment.
fn create_environment(name: ExecutionEnvironmentName) -> Arc<dyn ExecutionEnvironment> {
    match name {
        ExecutionEnvironmentName::Local => create_local_environment(),
        ExecutionEnvironmentName::Docker => create_docker_environment(),
    }
}

pub fn get_execution_environment() -> Arc<dyn ExecutionEnvironment> {
    if let Some(env) = INSTANCE.read().as_ref() {
        return env.clone();
    }
    let mut slot = INSTANCE.write();
    slot.get_or_insert_with(create_local_environment).clone()
}

/// The environment that can run a command with this cwd.
///
/// A thread the terminal UI started in a repository carries that repository's
/// absolute path, and the container's mounts were fixed when it was created, so
/// such a path is not in it. Those commands run on the host instead — the
/// alternative is breaking `prism` launched in a repo, which is how the terminal
/// UI is normally used.
pub fn get_execution_environment_for(cwd: Option<&str>) -> Arc<dyn ExecutionEnvironment> {
    let environment = get_execution_environment();
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return environment;
    };
    if environment.serves_path(cwd) {
        return environment;
    }
    report_fallback(cwd, environment.id());
    local_fallback()
}

fn serving_environment(path: &str) -> Arc<dyn ExecutionEnvironment> {
    let environment = get_execution_environment();
    if environment.serves_path(path) {
        environment
    } else {
        local_fallback()
    }
}

/// The filesystem that holds this path.
///
/// A path the deployment's environment serves is read through it; any other path
/// is on this machine. Every caller that has a path in hand asks here, so a thread
/// rooted in a host repository reads and writes the same files its shell sees.
/// Only a cwd is reported, since one thread touches many files.
pub fn files_for(file_path: &str) -> Arc<dyn ExecutionFiles> {
    serving_environment(file_path).files()
}

/// Resolve the environment and bring it up, once per process. Awaited at boot
/// and by `collect_tools()`; every later caller gets the settled result.
pub async fn ensure_execution_environment_detected() -> anyhow::Result<()> {
    let probe = PROBE.lock().clone();
    let settled = probe
        .get_or_init(|| async { resolve().await.map_err(Arc::new) })
        .await;
    match settled {
        Ok(()) => Ok(()),
        Err(err) => Err(anyhow::anyhow!("{err:#}")),
    }
}

/// The detection and start-up `ensure_execution_environment_detected` runs once.
async fn resolve() -> anyhow::Result<()> {
    let detection = match detect_environment(None).await {
        Ok(detection) => Some(detection),
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[ExecutionEnvironment] detection failed; running locally"
            );
            None
        }
    };
    let detection = match detection {
        Some(detection) if detection.name != ExecutionEnvironmentName::Local => detection,
        other => {
            *INSTANCE.write() = Some(create_local_environment());
            let reason = other.map_or_else(|| "detection failed".to_string(), |d| d.reason);
            log_info!(
                json!({ "environment": "local", "reason": reason }),
                "[Startup] execution environment"
            );
            return Ok(());
        }
    };

    let candidate = create_environment(detection.name);
    if let Err(err) = candidate.start().await {
        // An operator who named the environment gets the failure, because silently
        // running unconfined is not what they asked for. Otherwise an agent that
        // still works on the host beats one that will not boot.
        if detection.demanded {
            return Err(err);
        }
        log_warn!(
            json!({ "err": err_json(&err), "environment": detection.name }),
            "[ExecutionEnvironment] could not start; running locally"
        );
        *INSTANCE.write() = Some(create_local_environment());
        return Ok(());
    }
    let (id, detail) = (candidate.id(), candidate.display_name());
    *INSTANCE.write() = Some(candidate);
    log_info!(
        json!({ "environment": id, "detail": detail, "reason": detection.reason }),
        "[Startup] execution environment"
    );
    Ok(())
}

fn local_fallback() -> Arc<dyn ExecutionEnvironment> {
    if let Some(env) = FALLBACK.read().as_ref() {
        return env.clone();
    }
    let mut slot = FALLBACK.write();
    slot.get_or_insert_with(create_local_environment).clone()
}

/// The environment serving every path the deployment's environment does not:
/// this machine. The same directories as `get_execution_environment()` when that
/// one is local too.
pub fn get_host_environment() -> Arc<dyn ExecutionEnvironment> {
    local_fallback()
}

fn report_fallback(cwd: &str, environment: ExecutionEnvironmentName) {
    if !REPORTED.lock().insert(cwd.to_string()) {
        return;
    }
    log_info!(
        json!({ "cwd": cwd, "environment": environment }),
        "[ExecutionEnvironment] this path is outside the container; it is served from the host"
    );
}

/// Test-only: stand in a fake environment, or restore the real one with `None`.
pub fn set_execution_environment_for_tests(env: Option<Arc<dyn ExecutionEnvironment>>) {
    *INSTANCE.write() = env;
}

/// Test-only: forget the probe and the per-path reports.
pub fn reset_execution_environment_detection_for_tests() {
    *PROBE.lock() = Arc::new(OnceCell::new());
    *INSTANCE.write() = None;
    *FALLBACK.write() = None;
    REPORTED.lock().clear();
}
