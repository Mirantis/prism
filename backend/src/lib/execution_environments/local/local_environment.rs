//! The local execution environment: commands run as children of this process,
//! on the filesystem this process sees.

use std::sync::Arc;

use async_trait::async_trait;

use super::local_env::local_base_env;
use super::local_files::LocalFiles;
use super::local_paths::local_agent_paths;
use super::local_process::{run_local_program, run_local_shell};
use super::local_workspace::{prepare_local_workspace, resolve_local_workspace_root};
use crate::lib::agent_processes::AGENT_PROCESSES;
use crate::lib::execution_environments::execution_environment::{
    AgentPaths, ExecProcess, ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles,
    PreparedWorkspace, ProcessEnv, RunOptions, StdinMode,
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
        let with_stdin = options.stdin == StdinMode::Pipe;
        let command = command.to_string();
        AGENT_PROCESSES.track(
            Box::new(move || run_local_shell(&command, options, true)),
            with_stdin,
        )
    }

    /// Started through `AGENT_PROCESSES.track`, in a process group of its own.
    fn run_program(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> Arc<dyn ExecProcess> {
        let with_stdin = options.stdin == StdinMode::Pipe;
        let command = command.to_string();
        let args = args.to_vec();
        AGENT_PROCESSES.track(
            Box::new(move || run_local_program(&command, &args, options, true)),
            with_stdin,
        )
    }

    fn files(&self) -> Arc<dyn ExecutionFiles> {
        self.files.clone()
    }
}

#[cfg(test)]
mod tests {
    //! The local environment against real processes and a real temp directory,
    //! no mocks. What is proved here is the contract every implementation has to
    //! keep: when `ended` settles versus `closed`, and that a group kill reaches a
    //! grandchild.

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::lib::execution_environments::execution_environment::Signal;

    fn temp() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("local-env-")
            .tempdir()
            .unwrap();
        let path = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, path)
    }

    fn run(
        environment: &Arc<dyn ExecutionEnvironment>,
        dir: &str,
        command: &str,
    ) -> Arc<dyn ExecProcess> {
        environment.run_shell(
            command,
            RunOptions {
                cwd: dir.to_string(),
                env: environment.base_env(),
                stdin: StdinMode::Ignore,
            },
        )
    }

    async fn read_all(proc: &Arc<dyn ExecProcess>) -> String {
        let mut out = String::new();
        proc.take_stdout()
            .unwrap()
            .read_to_string(&mut out)
            .await
            .unwrap();
        out
    }

    #[test]
    fn identifies_itself() {
        let environment = create_local_environment();
        assert_eq!(environment.id(), ExecutionEnvironmentName::Local);
        assert_eq!(environment.display_name(), "local");
    }

    #[tokio::test]
    async fn hands_every_command_to_agent_processes() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = run(&environment, &dir, "sleep 5");
        assert!(AGENT_PROCESSES.holds(&proc));
        proc.kill(Signal::SIGKILL);
        proc.ended().await;
    }

    #[tokio::test]
    async fn reports_the_exit_code_and_the_output_a_command_produced() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = run(&environment, &dir, "echo out; echo err >&2; exit 3");
        let mut stderr = proc.take_stderr().unwrap();
        tokio::spawn(async move {
            let mut sink = Vec::new();
            let _ = stderr.read_to_end(&mut sink).await;
        });
        let out = read_all(&proc).await;
        let end = proc.closed().await;
        assert_eq!(end.exit_code, Some(3));
        assert!(end.error.is_none());
        assert_eq!(out, "out\n");
    }

    #[tokio::test]
    async fn runs_in_the_given_directory() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = run(&environment, &dir, "pwd");
        drop(proc.take_stderr());
        let out = read_all(&proc).await;
        proc.closed().await;
        assert_eq!(out.trim(), dir);
    }

    #[tokio::test]
    async fn reports_a_launch_failure_rather_than_failing() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = environment.run_program(
            "definitely-not-a-binary-x9",
            &[],
            RunOptions {
                cwd: dir,
                env: environment.base_env(),
                stdin: StdinMode::Ignore,
            },
        );
        let end = proc.ended().await;
        assert_eq!(
            end.error.unwrap().to_string(),
            "spawn definitely-not-a-binary-x9 ENOENT"
        );
        assert_eq!(end.exit_code, None);
    }

    #[tokio::test]
    async fn ends_before_it_closes_when_a_grandchild_still_holds_the_pipes() {
        // The shell exits at once; the background child keeps stdout open. Exit
        // accounting reads `ended` precisely so it does not wait for that child.
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = run(&environment, &dir, "sleep 0.4 & exit 0");
        let reader = tokio::spawn({
            let mut stdout = proc.take_stdout().unwrap();
            let mut stderr = proc.take_stderr().unwrap();
            async move {
                let mut sink = Vec::new();
                let _ = stdout.read_to_end(&mut sink).await;
                let _ = stderr.read_to_end(&mut sink).await;
            }
        });
        let first = tokio::select! {
            biased;
            _ = proc.ended() => "ended",
            _ = proc.closed() => "closed",
        };
        assert_eq!(first, "ended");
        proc.closed().await;
        reader.await.unwrap();
    }

    #[tokio::test]
    async fn kills_the_whole_group_so_a_grandchild_cannot_outlive_the_kill() {
        // Without the group kill this never closes: the shell is already gone and
        // its child holds the pipes for the next 30 seconds.
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = run(&environment, &dir, "sleep 30 & exit 0");
        let mut stdout = proc.take_stdout().unwrap();
        let mut stderr = proc.take_stderr().unwrap();
        tokio::spawn(async move {
            let mut sink = Vec::new();
            let _ = stdout.read_to_end(&mut sink).await;
            let _ = stderr.read_to_end(&mut sink).await;
        });
        proc.ended().await;
        assert!(proc.kill(Signal::SIGKILL));
        let end = tokio::time::timeout(std::time::Duration::from_secs(5), proc.closed())
            .await
            .expect("closed after the group kill");
        assert_eq!(end.exit_code, Some(0));
    }

    #[tokio::test]
    async fn marks_a_process_so_a_later_boot_can_stop_the_group_a_crash_left_running() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let before = crate::support::now_ms();
        let proc = run(&environment, &dir, "exit 0");
        proc.ended().await;
        let mark = proc.mark().expect("a mark");
        assert!(mark.pid > 0);
        assert!(mark.started_at >= before);
    }

    #[tokio::test]
    async fn writes_to_a_process_that_asked_for_stdin() {
        let (_guard, dir) = temp();
        let environment = create_local_environment();
        let proc = environment.run_shell(
            "cat",
            RunOptions {
                cwd: dir,
                env: environment.base_env(),
                stdin: StdinMode::Pipe,
            },
        );
        let mut stdin = proc.take_stdin().unwrap();
        stdin.write_all(b"hello\n").await.unwrap();
        stdin.shutdown().await.unwrap();
        drop(stdin);
        drop(proc.take_stderr());
        let out = read_all(&proc).await;
        proc.closed().await;
        assert_eq!(out, "hello\n");
    }
}
