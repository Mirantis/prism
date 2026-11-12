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
use super::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
};
use super::local::local_environment::create_local_environment;
use crate::lib::log_redaction::err_json;
use crate::{log_info, log_warn};

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

#[cfg(test)]
mod tests {
    //! These cases stand a fake in for the deployment's environment, so they run
    //! serialized with every case that reads or swaps it.

    use async_trait::async_trait;

    use super::*;
    use crate::lib::execution_environments::execution_environment::{
        AgentPaths, ExecProcess, PreparedWorkspace, ProcessEnv, RunOptions,
    };
    use crate::lib::execution_environments::local::local_files::LocalFiles;

    /// Puts the real environment back when the case ends.
    struct Restore;

    impl Drop for Restore {
        fn drop(&mut self) {
            reset_execution_environment_detection_for_tests();
        }
    }

    /// An environment that only answers which paths it serves, with one files
    /// handle a case can compare against.
    struct Fake {
        serves: Box<dyn Fn(&str) -> bool + Send + Sync>,
        files: Arc<dyn ExecutionFiles>,
    }

    #[async_trait]
    impl ExecutionEnvironment for Fake {
        fn id(&self) -> ExecutionEnvironmentName {
            ExecutionEnvironmentName::Local
        }
        fn display_name(&self) -> String {
            "fake".to_string()
        }
        fn workspace_root(&self) -> String {
            "/workspace".to_string()
        }
        fn paths(&self) -> AgentPaths {
            create_local_environment().paths()
        }
        fn prepare_workspace(&self) -> PreparedWorkspace {
            PreparedWorkspace {
                root: "/workspace".to_string(),
                fell_back_from: None,
            }
        }
        async fn start(&self) -> anyhow::Result<()> {
            Ok(())
        }
        async fn shutdown(&self) {}
        fn serves_path(&self, path: &str) -> bool {
            (self.serves)(path)
        }
        fn base_env(&self) -> ProcessEnv {
            ProcessEnv::new()
        }
        fn run_shell(&self, command: &str, options: RunOptions) -> Arc<dyn ExecProcess> {
            create_local_environment().run_shell(command, options)
        }
        fn run_program(
            &self,
            command: &str,
            args: &[String],
            options: RunOptions,
        ) -> Arc<dyn ExecProcess> {
            create_local_environment().run_program(command, args, options)
        }
        fn files(&self) -> Arc<dyn ExecutionFiles> {
            self.files.clone()
        }
    }

    fn fake(
        serves: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) -> Arc<dyn ExecutionEnvironment> {
        Arc::new(Fake {
            serves: Box::new(serves),
            files: Arc::new(LocalFiles),
        })
    }

    fn same<T: ?Sized>(a: &Arc<T>, b: &Arc<T>) -> bool {
        std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
    }

    #[test]
    #[serial_test::serial]
    fn serves_the_local_environment_until_a_probe_says_otherwise() {
        let _restore = Restore;
        reset_execution_environment_detection_for_tests();
        assert_eq!(
            get_execution_environment().id(),
            ExecutionEnvironmentName::Local
        );
        assert_eq!(get_execution_environment().display_name(), "local");
    }

    #[test]
    #[serial_test::serial]
    fn serves_one_instance_so_every_caller_shares_its_state() {
        let _restore = Restore;
        assert!(same(
            &get_execution_environment(),
            &get_execution_environment()
        ));
    }

    #[test]
    #[serial_test::serial]
    fn stands_in_a_test_environment_and_restores_the_real_one() {
        let _restore = Restore;
        let stand_in = fake(|_| true);
        set_execution_environment_for_tests(Some(stand_in.clone()));
        assert!(same(&get_execution_environment(), &stand_in));
        set_execution_environment_for_tests(None);
        assert_eq!(get_execution_environment().display_name(), "local");
    }

    #[test]
    #[serial_test::serial]
    fn uses_the_selected_environment_for_a_path_it_serves() {
        let _restore = Restore;
        let served = fake(|_| true);
        set_execution_environment_for_tests(Some(served.clone()));
        assert!(same(
            &get_execution_environment_for(Some("/data/workspace")),
            &served
        ));
    }

    #[test]
    #[serial_test::serial]
    fn falls_back_to_local_for_a_path_the_environment_cannot_reach() {
        let _restore = Restore;
        set_execution_environment_for_tests(Some(fake(|_| false)));
        let chosen = get_execution_environment_for(Some("/Users/me/dev/repo"));
        assert_eq!(chosen.display_name(), "local");
    }

    #[test]
    #[serial_test::serial]
    fn uses_the_selected_environment_when_no_path_is_given() {
        // No cwd means the environment's own root, which it serves by definition.
        let _restore = Restore;
        let served = fake(|_| false);
        set_execution_environment_for_tests(Some(served.clone()));
        assert!(same(&get_execution_environment_for(None), &served));
    }

    #[test]
    #[serial_test::serial]
    fn hands_every_unreachable_path_the_same_local_environment() {
        let _restore = Restore;
        set_execution_environment_for_tests(Some(fake(|_| false)));
        assert!(same(
            &get_execution_environment_for(Some("/a")),
            &get_execution_environment_for(Some("/b"))
        ));
    }

    #[test]
    #[serial_test::serial]
    fn reads_a_path_the_environment_serves_through_that_environment() {
        let _restore = Restore;
        let served = fake(|p| p.starts_with("/prism"));
        set_execution_environment_for_tests(Some(served.clone()));
        assert!(same(&files_for("/prism/skills"), &served.files()));
    }

    #[test]
    #[serial_test::serial]
    fn reads_any_other_path_on_this_machine() {
        let _restore = Restore;
        let served = fake(|p| p.starts_with("/prism"));
        set_execution_environment_for_tests(Some(served.clone()));
        let files = files_for("/Users/me/dev/repo/.claude/skills");
        assert!(same(&files, &get_host_environment().files()));
        assert!(!same(&files, &served.files()));
    }

    #[test]
    #[serial_test::serial]
    fn reports_a_cwd_once_and_never_a_file() {
        let _restore = Restore;
        set_execution_environment_for_tests(Some(fake(|_| false)));
        files_for("/Users/me/dev/repo/a.ts");
        assert!(REPORTED.lock().is_empty());
        get_execution_environment_for(Some("/Users/me/dev/repo"));
        get_execution_environment_for(Some("/Users/me/dev/repo"));
        assert_eq!(REPORTED.lock().len(), 1);
    }
}
