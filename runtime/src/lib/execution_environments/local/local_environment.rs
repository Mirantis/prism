//! The local execution environment: commands run as children of this process,
//! on the filesystem this process sees.

use std::sync::Arc;

use async_trait::async_trait;

use super::local_env::local_base_env;
use super::local_files::LocalFiles;
use super::local_paths::local_agent_paths;
use super::local_process::{run_local_program, run_local_shell};
use super::local_workspace::{prepare_local_workspace, resolve_local_workspace_root};
use crate::lib::execution_environments::execution_environment::{
    AgentPaths, ExecProcess, ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
    PreparedWorkspace, ProcessEnv, RunOptions,
};

pub struct LocalEnvironment {
    files: Arc<LocalFiles>,
}

pub fn create_local_environment() -> Arc<dyn ExecutionEnvironment> {
    Arc::new(LocalEnvironment {
        files: Arc::new(LocalFiles),
    })
}

#[async_trait]
impl ExecutionEnvironment for LocalEnvironment {
    fn id(&self) -> ExecutionEnvironmentName {
        ExecutionEnvironmentName::Local
    }

    fn display_name(&self) -> String {
        "local".to_string()
    }

    fn workspace_root(&self) -> String {
        resolve_local_workspace_root()
    }

    fn paths(&self) -> AgentPaths {
        local_agent_paths()
    }

    fn prepare_workspace(&self) -> PreparedWorkspace {
        prepare_local_workspace()
    }

    // Nothing to bring up or tear down: a command here is a child of this
    // process, and the filesystem is the one this process already has.
    async fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn shutdown(&self) {}

    // Every path this process can reach, which is what makes local the
    // fallback for a path no other environment serves.
    fn serves_path(&self, _path: &str) -> bool {
        true
    }

    fn base_env(&self) -> ProcessEnv {
        local_base_env(None)
    }

    /// Started through `AGENT_PROCESSES.track`, in a process group of its own.
    fn run_shell(&self, command: &str, options: RunOptions) -> Arc<dyn ExecProcess> {
        todo!()
    }

    /// Started through `AGENT_PROCESSES.track`, in a process group of its own.
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
