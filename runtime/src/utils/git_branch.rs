//! Resolve the current git branch of a directory.
//!
//! Used by the single-agent threads list to label each resumable conversation
//! with the branch its workspace root is on. Returns `None` when the directory
//! isn't a git work tree, is in detached-HEAD state, or git isn't available:
//! callers fall back to showing just the path.
//!
//! Asked of the execution environment: the directory is a thread's workspace
//! root, which is where the agent's own commands run.

use crate::lib::execution_environments::capture::{CaptureOptions, capture_program};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;
use crate::support::js;

const TIMEOUT_MS: u64 = 2_000;
/// A branch name; anything longer is not one.
const OUTPUT_LIMIT: usize = 4 * 1024;

/// Runs `git branch --show-current` in `dir` through `capture_program` in
/// `get_execution_environment_for(dir)`, with that environment's base env,
/// `TIMEOUT_MS` and `OUTPUT_LIMIT`. Not a git repo, detached HEAD (empty
/// output), git missing, or a directory that isn't there (an error or a
/// non-zero exit): no branch to show. The branch is the trimmed stdout, `None`
/// when empty.
pub async fn get_git_branch(dir: &str) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let environment = get_execution_environment_for(Some(dir));
    let run = capture_program(
        environment.as_ref(),
        "git",
        &["branch".to_string(), "--show-current".to_string()],
        CaptureOptions {
            cwd: dir.to_string(),
            env: environment.base_env(),
            timeout_ms: TIMEOUT_MS,
            limit_bytes: OUTPUT_LIMIT,
            abort_signal: None,
        },
    )
    .await;
    // Not a git repo, detached HEAD (empty output), git missing, or a directory
    // that isn't there — no branch to show.
    if run.error.is_some() || run.exit_code != Some(0) {
        return None;
    }
    let branch = js::trim(&run.stdout);
    if branch.is_empty() {
        return None;
    }
    Some(branch.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_the_current_branch_for_a_git_work_tree() {
        let repo = tempfile::Builder::new()
            .prefix("git-branch-repo-")
            .tempdir()
            .unwrap();
        // checkout -b creates an (unborn) branch with no commit required, and
        // works across git versions that lack `init -b`.
        git(repo.path(), &["init"]);
        git(repo.path(), &["checkout", "-b", "my-feature"]);
        let dir = repo.path().to_string_lossy().into_owned();
        assert_eq!(get_git_branch(&dir).await.as_deref(), Some("my-feature"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_none_for_a_non_git_directory() {
        let plain = tempfile::Builder::new()
            .prefix("git-branch-plain-")
            .tempdir()
            .unwrap();
        let dir = plain.path().to_string_lossy().into_owned();
        assert_eq!(get_git_branch(&dir).await, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_none_for_an_empty_path() {
        assert_eq!(get_git_branch("").await, None);
    }
}
