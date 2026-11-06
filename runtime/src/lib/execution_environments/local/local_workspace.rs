//! The local environment's workspace root — the default cwd for a command and
//! the base a relative tool path resolves from.

use crate::lib::execution_environments::execution_environment::PreparedWorkspace;
use crate::lib::execution_environments::workspace::path_resolve;

/// `SHELL_WORKSPACE_ROOT`, else `/home/node`, resolved.
pub fn resolve_local_workspace_root() -> String {
    let configured = std::env::var("SHELL_WORKSPACE_ROOT")
        .ok()
        .filter(|v| !v.is_empty());
    path_resolve(configured.as_deref().unwrap_or("/home/node"))
}

/// Ensure the workspace root exists, creating it if needed.
///
/// Called once at startup. The default `/home/node` exists in the container but
/// not when running locally (e.g. `npm run dev` on macOS, where `/home` isn't
/// writable). Spawning a shell with a non-existent `cwd` fails as
/// `spawn <cmd> ENOENT` — which looks like a missing shell rather than a missing
/// directory. When the configured root can't be created, fall back to a
/// writable temp dir (`<os tmpdir>/prism-workspace`) and pin it via
/// `SHELL_WORKSPACE_ROOT` so every subsequent `resolve_local_workspace_root()`
/// agrees.
///
/// Returns the usable root plus, when it differs, the path we couldn't create.
pub fn prepare_local_workspace() -> PreparedWorkspace {
    todo!()
}
