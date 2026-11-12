//! The Docker execution environment: the agent's commands run in a container,
//! and so does its storage.
//!
//! Everything the agent works with sits in named volumes the engine owns, at
//! fixed paths under `/prism` (see `volumes`). The runtime cannot open those
//! files, so `files` reaches them through the engine — which is what makes this
//! environment work on a remote engine, and on macOS and Windows without the
//! cost of a host bind mount. The volumes outlive the container, so nothing the
//! agent keeps is lost on a restart.

use std::sync::Arc;

use async_trait::async_trait;
use sha2::{Digest, Sha256};

use super::container::{ContainerSpec, start_container, stop_container};
use super::docker_env::docker_base_env;
use super::docker_files::create_docker_files;
use super::docker_process::{DockerExecContext, run_docker_program, run_docker_shell};
use super::volumes::{CONTAINER_PATHS, serves_path};
use crate::config::CONFIG;
use crate::lib::agent_processes::AGENT_PROCESSES;
use crate::lib::data_dir::resolve_data_dir;
use crate::lib::execution_environments::execution_environment::{
    AgentPaths, ExecProcess, ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
    PreparedWorkspace, ProcessEnv, RunOptions, StdinMode,
};

/// Hardcoded: the image is a component of this runtime, not a deployment choice.
pub const EXEC_IMAGE_REPO: &str = "ghcr.io/lensapp/prism-agent-exec";

/// The tag a build with no version of its own takes, and the one that moves.
pub const EXEC_IMAGE_FALLBACK_TAG: &str = "latest";

/// The image this runtime is paired with.
///
/// The tag is the runtime's own version, because the two are one component: the
/// runtime decides the argv, the paths and the wrapper the image has to
/// satisfy, so a runtime running against some later image is running against
/// something it was never proven with. Every published build tags the image with
/// the version it bakes into the runtime beside it: a SEA binary's release tag,
/// or an image's `SERVICE_VERSION`. A checkout has neither and takes `latest`.
///
/// `version` is `config.app_version`.
pub fn exec_image(version: &str) -> String {
    let tag = if version.is_empty() {
        EXEC_IMAGE_FALLBACK_TAG
    } else {
        version
    };
    format!("{EXEC_IMAGE_REPO}:{tag}")
}

/// Whether the engine's cached copy of this image can be out of date. Only the
/// fallback tag is republished; a version tag names one build for good.
pub fn is_moving_image(image: &str) -> bool {
    image.ends_with(&format!(":{EXEC_IMAGE_FALLBACK_TAG}"))
}

/// The container this deployment's commands run in.
pub fn exec_container_name(deployment: &str) -> String {
    format!("prism-agent-exec-{deployment}")
}

pub struct DockerEnvironment {
    pub deployment: String,
    pub container: String,
    pub image: String,
    ctx: DockerExecContext,
    files: Arc<dyn ExecutionFiles>,
}

/// The environment for this deployment, its image `exec_image(config.app_version)`.
pub fn create_docker_environment() -> Arc<dyn ExecutionEnvironment> {
    let deployment = deployment_id();
    let container = exec_container_name(&deployment);
    let image = exec_image(&CONFIG.app_version);
    let ctx = DockerExecContext {
        container: container.clone(),
    };
    let files = create_docker_files(&container);
    Arc::new(DockerEnvironment {
        deployment,
        container,
        image,
        ctx,
        files,
    })
}

#[async_trait]
impl ExecutionEnvironment for DockerEnvironment {
    fn id(&self) -> ExecutionEnvironmentName {
        ExecutionEnvironmentName::Docker
    }

    fn display_name(&self) -> String {
        format!("docker ({})", self.image)
    }

    fn workspace_root(&self) -> String {
        CONTAINER_PATHS.workspace_root.to_string()
    }

    fn paths(&self) -> AgentPaths {
        AgentPaths {
            skills_dir: CONTAINER_PATHS.skills_dir.to_string(),
            plugins_dir: CONTAINER_PATHS.plugins_dir.to_string(),
            plugin_data_dir: CONTAINER_PATHS.plugin_data_dir.to_string(),
            tool_output_dir: CONTAINER_PATHS.tool_output_dir.to_string(),
            claude_home: CONTAINER_PATHS.claude_home.to_string(),
            codex_home: CONTAINER_PATHS.codex_home.to_string(),
        }
    }

    // The image creates every one of these and the engine seeds each volume
    // from it, so the workspace exists before the first command and there is
    // nothing here to fall back from.
    fn prepare_workspace(&self) -> PreparedWorkspace {
        PreparedWorkspace {
            root: CONTAINER_PATHS.workspace_root.to_string(),
            fell_back_from: None,
        }
    }

    async fn start(&self) -> anyhow::Result<()> {
        start_container(&ContainerSpec {
            name: self.container.clone(),
            image: self.image.clone(),
            refresh_image: is_moving_image(&self.image),
            deployment: self.deployment.clone(),
        })
        .await
    }

    async fn shutdown(&self) {
        stop_container(&self.container, &self.image).await
    }

    fn serves_path(&self, path: &str) -> bool {
        serves_path(path)
    }

    fn base_env(&self) -> ProcessEnv {
        docker_base_env(None)
    }

    /// Started through `AGENT_PROCESSES.track`.
    fn run_shell(&self, command: &str, options: RunOptions) -> Arc<dyn ExecProcess> {
        let with_stdin = options.stdin == StdinMode::Pipe;
        let command = command.to_string();
        let ctx = self.ctx.clone();
        AGENT_PROCESSES.track(
            Box::new(move || run_docker_shell(&command, options, &ctx)),
            with_stdin,
        )
    }

    /// Started through `AGENT_PROCESSES.track`.
    fn run_program(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> Arc<dyn ExecProcess> {
        let with_stdin = options.stdin == StdinMode::Pipe;
        let command = command.to_string();
        let args = args.to_vec();
        let ctx = self.ctx.clone();
        AGENT_PROCESSES.track(
            Box::new(move || run_docker_program(&command, &args, options, &ctx)),
            with_stdin,
        )
    }

    fn files(&self) -> Arc<dyn ExecutionFiles> {
        self.files.clone()
    }
}

/// What separates one deployment's container and volumes from another's.
///
/// The data directory, not the agent id: the container is created before the
/// agent is resolved, so `config.agent_id` is still unset on a first boot and
/// every such install would answer to the same name. Two runtimes on one host
/// must already hold separate data dirs — that is where the database is — so
/// hashing it separates exactly the deployments that have to stay separate, and
/// gives the same container and the same volumes back on every restart of one.
///
/// The first 12 hex digits of the SHA-256 of `resolve_data_dir()`.
pub fn deployment_id() -> String {
    deployment_id_for(&resolve_data_dir())
}

/// The first 12 hex digits of the SHA-256 of `data_dir`.
pub fn deployment_id_for(data_dir: &str) -> String {
    let digest = Sha256::digest(data_dir.as_bytes());
    hex::encode(digest)[..12].to_string()
}

#[cfg(test)]
mod tests {
    //! What the environment is pointed at before it starts anything: the image it
    //! pairs with, the container and volumes it claims, and the paths it hands the
    //! rest of the runtime.

    use super::*;
    use crate::lib::execution_environments::docker::volumes::{VolumePurpose, volume_name};

    fn data_dir(name: &str) -> String {
        format!(
            "{}/{name}",
            std::env::temp_dir().to_string_lossy().trim_end_matches('/')
        )
    }

    /// Points the data dir somewhere for one case, and puts it back after.
    struct DataDir(Option<String>);

    impl DataDir {
        fn set(path: &str) -> DataDir {
            let previous = std::env::var("PRISM_DATA_DIR").ok();
            // SAFETY: serialized with every case that writes the environment.
            unsafe { std::env::set_var("PRISM_DATA_DIR", path) };
            DataDir(previous)
        }
    }

    impl Drop for DataDir {
        fn drop(&mut self) {
            // SAFETY: as above.
            unsafe {
                match &self.0 {
                    Some(value) => std::env::set_var("PRISM_DATA_DIR", value),
                    None => std::env::remove_var("PRISM_DATA_DIR"),
                }
            }
        }
    }

    #[test]
    fn pairs_the_image_with_the_runtime_build_that_asks_for_it() {
        assert_eq!(
            exec_image("v2026.9.21120000"),
            format!("{EXEC_IMAGE_REPO}:v2026.9.21120000")
        );
        assert_eq!(
            exec_image("canary-0f1e2d3"),
            format!("{EXEC_IMAGE_REPO}:canary-0f1e2d3")
        );
    }

    #[test]
    fn takes_the_moving_tag_for_a_build_carrying_no_version() {
        assert_eq!(exec_image(""), format!("{EXEC_IMAGE_REPO}:latest"));
    }

    #[test]
    fn says_which_image_the_engine_may_hold_a_stale_copy_of() {
        assert!(is_moving_image(&exec_image("")));
        assert!(!is_moving_image(&exec_image("v2026.9.21120000")));
    }

    #[test]
    #[serial_test::serial]
    fn names_a_deployment_by_its_data_dir() {
        let _dir = DataDir::set(&data_dir("prism-exec-env-a"));
        let id = deployment_id();
        assert_eq!(id.len(), 12);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(deployment_id(), id);
    }

    #[test]
    #[serial_test::serial]
    fn separates_two_runtimes_that_hold_separate_data() {
        let mine = {
            let _dir = DataDir::set(&data_dir("prism-exec-env-a"));
            deployment_id()
        };
        let theirs = {
            let _dir = DataDir::set(&data_dir("prism-exec-env-b"));
            deployment_id()
        };
        assert_ne!(theirs, mine);
        // Which is what keeps one runtime's workspace out of the other's.
        assert_ne!(
            volume_name(&mine, VolumePurpose::WorkspaceRoot),
            volume_name(&theirs, VolumePurpose::WorkspaceRoot)
        );
    }

    #[test]
    #[serial_test::serial]
    fn puts_the_agent_in_the_container_not_on_this_machine() {
        let _dir = DataDir::set(&data_dir("prism-exec-env-a"));
        let environment = create_docker_environment();
        assert_eq!(environment.workspace_root(), CONTAINER_PATHS.workspace_root);
        assert_eq!(
            environment.paths(),
            AgentPaths {
                skills_dir: CONTAINER_PATHS.skills_dir.to_string(),
                plugins_dir: CONTAINER_PATHS.plugins_dir.to_string(),
                plugin_data_dir: CONTAINER_PATHS.plugin_data_dir.to_string(),
                tool_output_dir: CONTAINER_PATHS.tool_output_dir.to_string(),
                claude_home: CONTAINER_PATHS.claude_home.to_string(),
                codex_home: CONTAINER_PATHS.codex_home.to_string(),
            }
        );
    }

    #[test]
    #[serial_test::serial]
    fn serves_the_container_tree_and_leaves_the_rest_to_the_local_environment() {
        let dir = data_dir("prism-exec-env-a");
        let _dir = DataDir::set(&dir);
        let environment = create_docker_environment();
        assert!(environment.serves_path(&format!("{}/my-skill", CONTAINER_PATHS.skills_dir)));
        // The database, and a repository the terminal UI was started in.
        assert!(!environment.serves_path(&format!("{dir}/agent.db")));
        assert!(!environment.serves_path("/Users/me/dev/repo"));
    }

    #[test]
    #[serial_test::serial]
    fn needs_nothing_prepared_on_this_machine_for_its_workspace() {
        let _dir = DataDir::set(&data_dir("prism-exec-env-a"));
        assert_eq!(
            create_docker_environment().prepare_workspace(),
            PreparedWorkspace {
                root: CONTAINER_PATHS.workspace_root.to_string(),
                fell_back_from: None,
            }
        );
    }
}
