//! The single owner of the per-thread-vs-default workspace fallback: returns the
//! given thread workspace root when it's a non-empty path, otherwise the
//! environment's own root. Every shell-tool invocation resolves its cwd through
//! here, as do the attachment and share-file tools, so the fallback lives in
//! exactly one place and a relative path means the same file to all of them.

use super::get_execution_environment::get_execution_environment;

pub fn resolve_workspace(workspace_root: Option<&str>) -> String {
    match workspace_root.map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => path_resolve(trimmed),
        _ => get_execution_environment().workspace_root(),
    }
}

/// `path.resolve(p)` for one argument: an absolute path normalized, a relative
/// one joined onto this process's cwd first.
pub(crate) fn path_resolve(p: &str) -> String {
    let joined = if p.starts_with('/') {
        p.to_string()
    } else {
        let cwd = std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_string());
        format!("{cwd}/{p}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}
