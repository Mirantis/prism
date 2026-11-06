//! Which environment serves this deployment.
//!
//! Docker is preferred when it is there, so the boundary costs no configuration
//! — but the answer is derived from four things in order, and the operator's
//! word is the first of them.

use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;

use crate::lib::execution_environments::execution_environment::ExecutionEnvironmentName;

/// A slow engine is a broken one for this purpose; the agent still has to boot.
pub const PROBE_TIMEOUT_MS: u64 = 10_000;

/// How long to keep asking an engine that is installed but not yet answering,
/// when the last run used a container. Docker Desktop started at login takes
/// about this long to come up, and giving up sooner would run one whole session
/// on this machine with its storage in the other place.
pub const ENGINE_WAIT_MS: u64 = 90_000;
pub const ENGINE_POLL_MS: u64 = 5_000;

/// What marks the runtime's own process as already living in a container.
pub const CONTAINER_MARKERS: [&str; 2] = ["/.dockerenv", "/run/.containerenv"];

/// What detection asks of the world, overridden in tests so no case depends on
/// an engine being installed.
#[derive(Clone)]
pub struct DetectionDeps {
    pub engine_answers: Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    /// The `docker` client is installed, whether or not its engine is up yet.
    pub client_installed: Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>,
    /// The environment the previous run recorded, or `None` before any record.
    pub last_environment: Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync>,
    pub wait: Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>,
    pub in_container: Arc<dyn Fn() -> bool + Send + Sync>,
    /// `EXECUTION_ENVIRONMENT`, trimmed and lowercased; `None` when unset or empty.
    pub configured: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Detection {
    pub name: ExecutionEnvironmentName,
    /// Why, for the startup log — an operator who expected Docker needs to know.
    pub reason: String,
    /// The operator asked for this by name, so a failure to start must not degrade.
    pub demanded: bool,
}

/// The real engine probe, `has_binaries("docker")`, the `runtime_state` record,
/// a tokio sleep, the container marker files and `EXECUTION_ENVIRONMENT`.
pub fn default_detection_deps() -> DetectionDeps {
    todo!()
}

/// `deps` defaults to `default_detection_deps()`.
pub async fn detect_environment(deps: Option<DetectionDeps>) -> anyhow::Result<Detection> {
    todo!()
}

/// Keep asking an engine the last run used, until it answers or the wait ends.
async fn wait_for_engine(deps: &DetectionDeps) -> Detection {
    todo!()
}

/// Whether a `docker` client is installed *and* its engine is actually up.
async fn engine_answers() -> bool {
    todo!()
}
