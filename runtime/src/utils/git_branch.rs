//! Resolve the current git branch of a directory.
//!
//! Used by the single-agent threads list to label each resumable conversation
//! with the branch its workspace root is on. Returns `None` when the directory
//! isn't a git work tree, is in detached-HEAD state, or git isn't available:
//! callers fall back to showing just the path.
//!
//! Asked of the execution environment: the directory is a thread's workspace
//! root, which is where the agent's own commands run.

const TIMEOUT_MS: i64 = 2_000;
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
    todo!()
}
