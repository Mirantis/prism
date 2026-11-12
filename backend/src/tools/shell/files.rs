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
use serde_json::{Value, json};

use super::edit::{EditOutcome, apply_edit};
use super::format::format_file_content;
use super::workspace::{is_inside_workspace, resolve_path};
use crate::lib::execution_environments::get_execution_environment::{
    files_for, get_execution_environment,
};

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

const PATH_DESCRIPTION: &str = "File path. Relative paths are resolved from the workspace root.";

/// `Number.MAX_SAFE_INTEGER`, the bound zod gives an integer with no `max`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn read_file_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": PATH_DESCRIPTION },
            "offset": {
                "description": "Line number to start reading from (1-indexed, default: 1)",
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_SAFE_INTEGER
            },
            "limit": {
                "description": "Maximum number of lines to read (default: 2000)",
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_SAFE_INTEGER
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

pub fn write_file_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": PATH_DESCRIPTION },
            "content": { "type": "string", "description": "File content to write" }
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

pub fn edit_file_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": PATH_DESCRIPTION },
            "old_string": { "type": "string", "description": "The exact text to find and replace" },
            "new_string": {
                "type": "string",
                "description": "The replacement text (must differ from old_string)"
            },
            "replace_all": {
                "description": "Replace all occurrences (default: false, requires unique match)",
                "type": "boolean"
            }
        },
        "required": ["path", "old_string", "new_string"],
        "additionalProperties": false
    })
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
    let full_path = resolve_path(workspace, &input.path);
    if let Some(error) = reject_outside_workspace(&full_path, workspace) {
        return ReadFileResult::Error { error };
    }
    match files_for(&full_path).read_text(&full_path, None).await {
        Ok(raw) => ReadFileResult::Content {
            content: format_file_content(&raw, input.offset, input.limit),
        },
        Err(err) => ReadFileResult::Error {
            error: err.to_string(),
        },
    }
}

/// Creates the parent directory first.
pub async fn run_write_file(input: WriteFileInput, workspace: &str) -> WriteFileResult {
    let full_path = resolve_path(workspace, &input.path);
    if let Some(error) = reject_outside_workspace(&full_path, workspace) {
        return WriteFileResult::Error { error };
    }
    let files = files_for(&full_path);
    if let Err(err) = files.mkdir(&dirname(&full_path)).await {
        return WriteFileResult::Error {
            error: err.to_string(),
        };
    }
    match files.write_text(&full_path, &input.content, None).await {
        Ok(()) => WriteFileResult::Ok { ok: true },
        Err(err) => WriteFileResult::Error {
            error: err.to_string(),
        },
    }
}

pub async fn run_edit_file(input: EditFileInput, workspace: &str) -> WriteFileResult {
    let full_path = resolve_path(workspace, &input.path);
    if let Some(error) = reject_outside_workspace(&full_path, workspace) {
        return WriteFileResult::Error { error };
    }
    let files = files_for(&full_path);
    let original = match files.read_text(&full_path, None).await {
        Ok(original) => original,
        Err(err) => {
            return WriteFileResult::Error {
                error: err.to_string(),
            };
        }
    };
    let content = match apply_edit(
        &original,
        &input.old_string,
        &input.new_string,
        input.replace_all.unwrap_or(false),
    ) {
        EditOutcome::Ok { content } => content,
        EditOutcome::Error { message } => return WriteFileResult::Error { error: message },
    };
    match files.write_text(&full_path, &content, None).await {
        Ok(()) => WriteFileResult::Ok { ok: true },
        Err(err) => WriteFileResult::Error {
            error: err.to_string(),
        },
    }
}

/// `path.dirname` of an absolute, normalized path.
fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(at) => path[..at].to_string(),
        None => ".".to_string(),
    }
}

#[cfg(test)]
mod tests {
    //! The file tool handlers against a real temp directory as the workspace.

    use super::*;

    fn workspace() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("shell-tools-test-")
            .tempdir()
            .unwrap();
        let path = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, path)
    }

    fn write(path: &str, content: &str) -> WriteFileInput {
        WriteFileInput {
            path: path.to_string(),
            content: content.to_string(),
        }
    }

    fn read(path: &str) -> ReadFileInput {
        ReadFileInput {
            path: path.to_string(),
            offset: None,
            limit: None,
        }
    }

    fn edit(path: &str, old: &str, new: &str, all: Option<bool>) -> EditFileInput {
        EditFileInput {
            path: path.to_string(),
            old_string: old.to_string(),
            new_string: new.to_string(),
            replace_all: all,
        }
    }

    fn error_of(result: WriteFileResult) -> String {
        match result {
            WriteFileResult::Error { error } => error,
            WriteFileResult::Ok { .. } => panic!("expected an error"),
        }
    }

    fn fixture_schema(name: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tool-schemas.json"
        )))
        .unwrap();
        fixture["shell"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap()["inputSchema"]
            .clone()
    }

    #[test]
    fn declares_the_schemas_the_typescript_runtime_sends() {
        for (name, schema) in [
            ("shell_read_file", read_file_input_schema()),
            ("shell_write_file", write_file_input_schema()),
            ("shell_edit_file", edit_file_input_schema()),
        ] {
            let expected = fixture_schema(name);
            assert_eq!(
                serde_json::to_string(&schema).unwrap(),
                serde_json::to_string(&expected).unwrap(),
                "{name}"
            );
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_relative_paths_that_escape_the_workspace() {
        let (_guard, ws) = workspace();
        let ReadFileResult::Error { error } = run_read_file(read("../etc/passwd"), &ws).await
        else {
            panic!("expected an error");
        };
        assert!(error.contains("Path outside workspace"));
        let error = error_of(run_write_file(write("../escape.txt", "nope"), &ws).await);
        assert!(error.contains("Path outside workspace"));
    }

    /// Puts the install-dir variables back when the case ends.
    struct InstallDirs;

    impl Drop for InstallDirs {
        fn drop(&mut self) {
            // SAFETY: these cases are serialized with every case that writes the environment.
            unsafe {
                std::env::remove_var("PRISM_SKILLS_DIR");
                std::env::remove_var("PRISM_PLUGINS_DIR");
            }
        }
    }

    fn install_dirs() -> (tempfile::TempDir, String, InstallDirs) {
        let data = tempfile::Builder::new()
            .prefix("shell-data-test-")
            .tempdir()
            .unwrap();
        let path = std::fs::canonicalize(data.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // SAFETY: serialized with every case that writes the environment.
        unsafe {
            std::env::set_var("PRISM_SKILLS_DIR", format!("{path}/skills"));
            std::env::set_var("PRISM_PLUGINS_DIR", format!("{path}/plugins"));
        }
        (data, path, InstallDirs)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_a_skill_bundle_and_reads_it_back() {
        let (_ws_guard, ws) = workspace();
        let (_guard, data, _restore) = install_dirs();
        let skill = format!("{data}/skills/tidy-up/SKILL.md");

        let result = run_write_file(write(&skill, "---\nname: tidy-up\n---\n"), &ws).await;
        assert_eq!(result, WriteFileResult::Ok { ok: true });

        let ReadFileResult::Content { content } = run_read_file(read(&skill), &ws).await else {
            panic!("expected content");
        };
        assert!(content.contains("tidy-up"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_a_plugin_manifest() {
        let (_ws_guard, ws) = workspace();
        let (_guard, data, _restore) = install_dirs();
        let manifest = format!("{data}/plugins/weather/plugin.json");
        let result = run_write_file(write(&manifest, "{}"), &ws).await;
        assert_eq!(result, WriteFileResult::Ok { ok: true });
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_the_rest_of_the_data_directory() {
        // The database, the stored attachments and the saved tool outputs are the
        // runtime's own files.
        let (_ws_guard, ws) = workspace();
        let (_guard, data, _restore) = install_dirs();
        let database = format!("{data}/agent.db");
        let error = error_of(run_write_file(write(&database, "nope"), &ws).await);
        assert!(error.contains("Path outside workspace"));
        assert!(!std::path::Path::new(&database).exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn names_the_places_a_file_may_go() {
        let (_ws_guard, ws) = workspace();
        let (_guard, data, _restore) = install_dirs();
        let error = error_of(run_write_file(write("/etc/nope.txt", "no"), &ws).await);
        assert!(error.contains(&format!("{data}/skills")));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn write_then_read_roundtrips_and_creates_parent_directories() {
        let (_guard, ws) = workspace();
        let result = run_write_file(write("nested/sub/file.txt", "line1\nline2\n"), &ws).await;
        assert_eq!(result, WriteFileResult::Ok { ok: true });
        let ReadFileResult::Content { content } =
            run_read_file(read("nested/sub/file.txt"), &ws).await
        else {
            panic!("expected content");
        };
        assert!(content.contains("1: line1"));
        assert!(content.contains("2: line2"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn edit_applies_exact_match_replacement() {
        let (_guard, ws) = workspace();
        run_write_file(write("edit.txt", "hello world"), &ws).await;
        let result = run_edit_file(edit("edit.txt", "hello", "goodbye", None), &ws).await;
        assert_eq!(result, WriteFileResult::Ok { ok: true });
        let text = std::fs::read_to_string(format!("{ws}/edit.txt")).unwrap();
        assert_eq!(text, "goodbye world");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn edit_fails_when_old_string_matches_multiple_times_without_replace_all() {
        let (_guard, ws) = workspace();
        run_write_file(write("multi.txt", "aa bb aa"), &ws).await;
        let error = error_of(run_edit_file(edit("multi.txt", "aa", "cc", None), &ws).await);
        assert!(error.contains("2 matches"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn edit_replaces_all_occurrences_when_replace_all_is_true() {
        let (_guard, ws) = workspace();
        run_write_file(write("multi2.txt", "aa bb aa"), &ws).await;
        let result = run_edit_file(edit("multi2.txt", "aa", "cc", Some(true)), &ws).await;
        assert_eq!(result, WriteFileResult::Ok { ok: true });
        let text = std::fs::read_to_string(format!("{ws}/multi2.txt")).unwrap();
        assert_eq!(text, "cc bb cc");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn read_returns_an_enoent_shaped_error_for_missing_files() {
        let (_guard, ws) = workspace();
        let ReadFileResult::Error { error } = run_read_file(read("does-not-exist.txt"), &ws).await
        else {
            panic!("expected an error");
        };
        assert_eq!(
            error,
            format!("ENOENT: no such file or directory, open '{ws}/does-not-exist.txt'")
        );
    }
}
