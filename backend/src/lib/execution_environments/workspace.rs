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

pub(crate) use crate::support::path::resolve as path_resolve;
