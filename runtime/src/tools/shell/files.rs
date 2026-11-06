//! File manipulation tools:
//!   - shell_read_file
//!   - shell_write_file
//!   - shell_edit_file
//!
//! Mirror the upstream input schemas + behavior from the Lens Agents shell
//! sandbox's shell schemas and file handlers.
//!
//! Security model (inherited from upstream): `resolve_path` resolves
//! relative paths against the workspace root and normalizes absolute
//! paths as-is; `is_inside_workspace` then rejects anything not contained
//! in the workspace. Net effect: relative `..` traversal AND absolute
//! paths outside the workspace are both rejected. Real boundary is
//! still filesystem permissions; this layer matches the upstream shell
//! sandbox's workspace semantics.
//!
//! The skills and plugins directories are reachable as well, since that is where a skill
//! or a plugin is installed and the prompt tells the agent to put one there.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::workspace::is_inside_workspace;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;

#[derive(Debug, Clone, Deserialize)]
pub struct ReadFileInput {
    /// File path. Relative paths are resolved from the workspace root.
    pub path: String,
    /// Line number to start reading from (1-indexed, default: 1).
    #[serde(default)]
    pub offset: Option<i64>,
    /// Maximum number of lines to read (default: 2000).
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WriteFileInput {
    /// File path. Relative paths are resolved from the workspace root.
    pub path: String,
    /// File content to write.
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EditFileInput {
    /// File path. Relative paths are resolved from the workspace root.
    pub path: String,
    /// The exact text to find and replace.
    pub old_string: String,
    /// The replacement text (must differ from old_string).
    pub new_string: String,
    /// Replace all occurrences (default: false, requires unique match).
    #[serde(default)]
    pub replace_all: Option<bool>,
}

pub fn read_file_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn write_file_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn edit_file_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// `{ content }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ReadFileResult {
    Content { content: String },
    Error { error: String },
}

/// `{ ok: true }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WriteFileResult {
    Ok { ok: bool },
    Error { error: String },
}

/// Where a file tool may work, beyond the workspace root.
///
/// A skill and a plugin are installed by landing a bundle in the data dir, which is what
/// the `# Skills` and `# Plugins` sections of the prompt tell the agent to do. `shell_exec`
/// has always been able to write there — it takes a command rather than a path, so nothing
/// checks where it lands — so a file tool refusing the same write left the two disagreeing
/// and made the prompt's own instruction false for one of them.
///
/// Read on each call rather than once: `PRISM_SKILLS_DIR` and `PRISM_PLUGINS_DIR` move
/// these, and a test sets them per case.
///
/// The rest of the data dir stays out. The database, the stored attachments and the saved
/// tool outputs are the runtime's own files, and a tool that overwrites a whole file has no
/// business in them.
fn install_dirs() -> Vec<String> {
    let paths = get_execution_environment().paths();
    vec![paths.skills_dir, paths.plugins_dir]
}

fn reject_outside_workspace(full_path: &str, workspace: &str) -> Option<String> {
    if is_inside_workspace(full_path, workspace) {
        return None;
    }
    let reachable = install_dirs();
    if reachable
        .iter()
        .any(|dir| is_inside_workspace(full_path, dir))
    {
        return None;
    }
    Some(format!(
        "Path outside workspace. Write under {workspace}, or into {}.",
        reachable.join(" or ")
    ))
}

/// Read through the filesystem holding the path (`files_for`), so a write here
/// and the thread's `shell_exec` agree.
pub async fn run_read_file(input: ReadFileInput, workspace: &str) -> ReadFileResult {
    todo!()
}

/// Creates the parent directory first.
pub async fn run_write_file(input: WriteFileInput, workspace: &str) -> WriteFileResult {
    todo!()
}

pub async fn run_edit_file(input: EditFileInput, workspace: &str) -> WriteFileResult {
    todo!()
}
