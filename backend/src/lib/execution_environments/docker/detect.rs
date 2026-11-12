//! Which environment serves this deployment.
//!
//! Docker is preferred when it is there, so the boundary costs no configuration
//! — but the answer is derived from four things in order, and the operator's
//! word is the first of them.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::json;

use super::engine::{EngineCallOptions, engine_call_args};
use crate::lib::execution_environments::execution_environment::ExecutionEnvironmentName;
use crate::lib::has_binary::has_binaries;
use crate::log_info;
use crate::services::runtime_state_service::{LAST_EXECUTION_ENVIRONMENT, RUNTIME_STATE_SERVICE};
use crate::support::js;

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
    DetectionDeps {
        engine_answers: Arc::new(|| Box::pin(engine_answers())),
        client_installed: Arc::new(|| Box::pin(has_binaries(&["docker"]))),
        last_environment: Arc::new(|| {
            Box::pin(async {
                RUNTIME_STATE_SERVICE
                    .get(LAST_EXECUTION_ENVIRONMENT)
                    .await
                    .unwrap_or(None)
            })
        }),
        wait: Arc::new(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms)))),
        in_container: Arc::new(|| {
            CONTAINER_MARKERS
                .iter()
                .any(|marker| std::path::Path::new(marker).exists())
        }),
        configured: Arc::new(|| {
            std::env::var("EXECUTION_ENVIRONMENT")
                .ok()
                .map(|value| js::trim(&value).to_lowercase())
                .filter(|value| !value.is_empty())
        }),
    }
}

fn detection(
    name: ExecutionEnvironmentName,
    reason: impl Into<String>,
    demanded: bool,
) -> Detection {
    Detection {
        name,
        reason: reason.into(),
        demanded,
    }
}

/// `deps` defaults to `default_detection_deps()`.
pub async fn detect_environment(deps: Option<DetectionDeps>) -> anyhow::Result<Detection> {
    let deps = deps.unwrap_or_else(default_detection_deps);
    let configured = (deps.configured)();
    match configured.as_deref() {
        Some("docker") => {
            return Ok(detection(
                ExecutionEnvironmentName::Docker,
                "EXECUTION_ENVIRONMENT=docker",
                true,
            ));
        }
        Some("local") => {
            return Ok(detection(
                ExecutionEnvironmentName::Local,
                "EXECUTION_ENVIRONMENT=local",
                true,
            ));
        }
        Some(other) => {
            return Ok(detection(
                ExecutionEnvironmentName::Local,
                format!("unknown EXECUTION_ENVIRONMENT \"{other}\""),
                false,
            ));
        }
        None => {}
    }

    // The published image is already the boundary, and it holds the toolchain a
    // command expects. Starting a sibling would take that away from every
    // install that mounts an engine socket for some other reason.
    if (deps.in_container)() {
        return Ok(detection(
            ExecutionEnvironmentName::Local,
            "the runtime is already in a container",
            false,
        ));
    }

    if (deps.engine_answers)().await {
        return Ok(detection(
            ExecutionEnvironmentName::Docker,
            "a container engine answered",
            false,
        ));
    }
    if (deps.last_environment)().await.as_deref() == Some("docker")
        && (deps.client_installed)().await
    {
        return Ok(wait_for_engine(&deps).await);
    }
    Ok(detection(
        ExecutionEnvironmentName::Local,
        "no container engine",
        false,
    ))
}

/// Keep asking an engine the last run used, until it answers or the wait ends.
async fn wait_for_engine(deps: &DetectionDeps) -> Detection {
    log_info!(
        json!({ "waitMs": ENGINE_WAIT_MS }),
        "[Startup] the last run used a container and the engine is not answering yet; waiting for it"
    );
    let mut waited = 0;
    while waited < ENGINE_WAIT_MS {
        (deps.wait)(ENGINE_POLL_MS).await;
        if (deps.engine_answers)().await {
            return detection(
                ExecutionEnvironmentName::Docker,
                "a container engine answered after a wait",
                false,
            );
        }
        waited += ENGINE_POLL_MS;
    }
    detection(
        ExecutionEnvironmentName::Local,
        "the container engine did not answer",
        false,
    )
}

/// Whether a `docker` client is installed *and* its engine is actually up.
async fn engine_answers() -> bool {
    // The binary alone proves nothing: a machine with Docker Desktop installed
    // and not running has the client on PATH and no daemon behind it.
    if !has_binaries(&["docker"]).await {
        return false;
    }
    let run = engine_call_args(
        &["version", "--format", "{{.Server.Version}}"],
        EngineCallOptions {
            timeout_ms: PROBE_TIMEOUT_MS,
            env: None,
        },
    )
    .await;
    run.error.is_none() && !run.timed_out && run.exit_code == Some(0)
}

#[cfg(test)]
mod tests {
    //! Detection, through injected probes only. Nothing here asks the real
    //! engine: CI runners have Docker and developer machines vary.

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    fn deps() -> DetectionDeps {
        DetectionDeps {
            engine_answers: Arc::new(|| Box::pin(async { false })),
            client_installed: Arc::new(|| Box::pin(async { false })),
            last_environment: Arc::new(|| Box::pin(async { None })),
            wait: Arc::new(|_| Box::pin(async {})),
            in_container: Arc::new(|| false),
            configured: Arc::new(|| None),
        }
    }

    fn answers(value: bool) -> Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync> {
        Arc::new(move || Box::pin(async move { value }))
    }

    fn configured(value: &'static str) -> Arc<dyn Fn() -> Option<String> + Send + Sync> {
        Arc::new(move || Some(value.to_string()))
    }

    fn last(
        value: &'static str,
    ) -> Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync> {
        Arc::new(move || Box::pin(async move { Some(value.to_string()) }))
    }

    async fn detect(deps: DetectionDeps) -> Detection {
        detect_environment(Some(deps)).await.unwrap()
    }

    #[tokio::test]
    async fn prefers_docker_when_an_engine_answers_with_nothing_configured() {
        let found = detect(DetectionDeps {
            engine_answers: answers(true),
            ..deps()
        })
        .await;
        assert_eq!(
            found,
            detection(
                ExecutionEnvironmentName::Docker,
                "a container engine answered",
                false
            )
        );
    }

    #[tokio::test]
    async fn runs_locally_when_no_engine_answers() {
        let found = detect(deps()).await;
        assert_eq!(found.name, ExecutionEnvironmentName::Local);
        assert!(!found.demanded);
    }

    #[tokio::test]
    async fn takes_the_operator_over_the_probe_both_ways() {
        let forced = detect(DetectionDeps {
            configured: configured("docker"),
            engine_answers: answers(false),
            ..deps()
        })
        .await;
        // Demanded, so a failure to start must be reported rather than degraded.
        assert_eq!(
            forced,
            detection(
                ExecutionEnvironmentName::Docker,
                "EXECUTION_ENVIRONMENT=docker",
                true
            )
        );

        let refused = detect(DetectionDeps {
            configured: configured("local"),
            engine_answers: answers(true),
            ..deps()
        })
        .await;
        assert_eq!(refused.name, ExecutionEnvironmentName::Local);
        assert!(refused.demanded);
    }

    #[tokio::test]
    async fn runs_locally_on_an_unreadable_setting_and_says_which_one() {
        let found = detect(DetectionDeps {
            configured: configured("podman"),
            engine_answers: answers(true),
            ..deps()
        })
        .await;
        assert_eq!(found.name, ExecutionEnvironmentName::Local);
        assert!(found.reason.contains("podman"));
        assert!(!found.demanded);
    }

    #[tokio::test]
    async fn stays_local_when_the_runtime_is_itself_in_a_container() {
        let found = detect(DetectionDeps {
            in_container: Arc::new(|| true),
            engine_answers: answers(true),
            ..deps()
        })
        .await;
        assert_eq!(found.name, ExecutionEnvironmentName::Local);
        assert_eq!(found.reason, "the runtime is already in a container");
    }

    #[tokio::test]
    async fn lets_an_operator_opt_into_docker_from_inside_a_container() {
        let found = detect(DetectionDeps {
            in_container: Arc::new(|| true),
            configured: configured("docker"),
            ..deps()
        })
        .await;
        assert_eq!(found.name, ExecutionEnvironmentName::Docker);
        assert!(found.demanded);
    }

    #[tokio::test]
    async fn waits_for_an_engine_that_is_installed_but_still_starting() {
        let asked = Arc::new(AtomicUsize::new(0));
        let counter = asked.clone();
        let found = detect(DetectionDeps {
            last_environment: last("docker"),
            client_installed: answers(true),
            // Down on the first probe and the first wait, up on the second.
            engine_answers: Arc::new(move || {
                let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move { n >= 3 })
            }),
            ..deps()
        })
        .await;
        assert_eq!(
            found,
            detection(
                ExecutionEnvironmentName::Docker,
                "a container engine answered after a wait",
                false
            )
        );
    }

    #[tokio::test]
    async fn runs_locally_once_the_wait_ends_with_no_answer() {
        let waits = Arc::new(AtomicUsize::new(0));
        let counter = waits.clone();
        let found = detect(DetectionDeps {
            last_environment: last("docker"),
            client_installed: answers(true),
            wait: Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }),
            ..deps()
        })
        .await;
        assert_eq!(found.name, ExecutionEnvironmentName::Local);
        assert_eq!(found.reason, "the container engine did not answer");
        // Bounded: the whole wait is a fixed number of polls.
        let n = waits.load(Ordering::SeqCst);
        assert!(n > 1 && n < 60, "{n}");
    }

    #[tokio::test]
    async fn does_not_wait_when_the_client_is_not_installed_at_all() {
        let waited = Arc::new(AtomicBool::new(false));
        let flag = waited.clone();
        let found = detect(DetectionDeps {
            last_environment: last("docker"),
            wait: Arc::new(move |_| {
                flag.store(true, Ordering::SeqCst);
                Box::pin(async {})
            }),
            ..deps()
        })
        .await;
        // An uninstalled engine is not coming back, so boot is not held up.
        assert_eq!(found.name, ExecutionEnvironmentName::Local);
        assert_eq!(found.reason, "no container engine");
        assert!(!waited.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn does_not_wait_when_the_last_run_was_local() {
        let waited = Arc::new(AtomicBool::new(false));
        let flag = waited.clone();
        detect(DetectionDeps {
            last_environment: last("local"),
            client_installed: answers(true),
            wait: Arc::new(move |_| {
                flag.store(true, Ordering::SeqCst);
                Box::pin(async {})
            }),
            ..deps()
        })
        .await;
        assert!(!waited.load(Ordering::SeqCst));
    }
}
