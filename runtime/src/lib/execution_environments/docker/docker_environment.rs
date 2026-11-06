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
use crate::lib::execution_environments::execution_environment::{
    AgentPaths, ExecProcess, ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
    PreparedWorkspace, ProcessEnv, RunOptions,
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
    todo!()
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
        todo!()
    }

    /// Started through `AGENT_PROCESSES.track`.
    fn run_program(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> Arc<dyn ExecProcess> {
        todo!()
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
    todo!()
}

/// The first 12 hex digits of the SHA-256 of `data_dir`.
pub fn deployment_id_for(data_dir: &str) -> String {
    let digest = Sha256::digest(data_dir.as_bytes());
    hex::encode(digest)[..12].to_string()
}
