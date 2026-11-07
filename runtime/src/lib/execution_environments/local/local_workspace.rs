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
    let desired = resolve_local_workspace_root();
    if std::fs::create_dir_all(&desired).is_ok() {
        return PreparedWorkspace {
            root: desired,
            fell_back_from: None,
        };
    }
    let fallback = format!("{}/prism-workspace", os_tmpdir());
    // A failure here is the same as Node's mkdirSync throwing: the boot reports it.
    let _ = std::fs::create_dir_all(&fallback);
    // SAFETY: called once at boot, before any thread reads the environment.
    unsafe { std::env::set_var("SHELL_WORKSPACE_ROOT", &fallback) };
    PreparedWorkspace {
        root: fallback,
        fell_back_from: Some(desired),
    }
}

/// `os.tmpdir()`: `TMPDIR`, `TMP` or `TEMP` without a trailing slash, else `/tmp`.
pub(crate) fn os_tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()));
    let Some(mut dir) = configured else {
        return "/tmp".to_string();
    };
    if dir.len() > 1 && dir.ends_with('/') {
        dir.pop();
    }
    dir
}

#[cfg(test)]
mod tests {
    //! The boot-time guard that creates the shell workspace dir, and falls back
    //! when the configured root can't be created. Uses the real filesystem: the
    //! fallback is forced by pointing the root at a path *under an existing
    //! file*, which makes a recursive mkdir fail deterministically.

    use super::*;

    /// Puts `SHELL_WORKSPACE_ROOT` back when the case ends.
    struct RestoreRoot(Option<String>);

    impl Drop for RestoreRoot {
        fn drop(&mut self) {
            // SAFETY: these cases are serialized on the variable.
            unsafe {
                match &self.0 {
                    Some(value) => std::env::set_var("SHELL_WORKSPACE_ROOT", value),
                    None => std::env::remove_var("SHELL_WORKSPACE_ROOT"),
                }
            }
        }
    }

    #[test]
    #[serial_test::serial(shell_workspace_root)]
    fn creates_the_configured_root_and_reports_no_fallback() {
        let _restore = RestoreRoot(std::env::var("SHELL_WORKSPACE_ROOT").ok());
        let base = tempfile::Builder::new().prefix("ws-cfg-").tempdir().unwrap();
        let root = format!("{}/nested/workspace", base.path().to_string_lossy());
        // SAFETY: serialized on the variable.
        unsafe { std::env::set_var("SHELL_WORKSPACE_ROOT", &root) };

        let result = prepare_local_workspace();

        assert_eq!(
            result,
            PreparedWorkspace {
                root: path_resolve(&root),
                fell_back_from: None
            }
        );
        assert!(std::path::Path::new(&root).is_dir());
    }

    #[test]
    #[serial_test::serial(shell_workspace_root)]
    fn falls_back_to_a_temp_dir_when_the_configured_root_cannot_be_created() {
        let _restore = RestoreRoot(std::env::var("SHELL_WORKSPACE_ROOT").ok());
        let base = tempfile::Builder::new().prefix("ws-bad-").tempdir().unwrap();
        let file = format!("{}/not-a-dir", base.path().to_string_lossy());
        std::fs::write(&file, "x").unwrap();
        let desired = format!("{file}/workspace");
        // SAFETY: serialized on the variable.
        unsafe { std::env::set_var("SHELL_WORKSPACE_ROOT", &desired) };

        let fallback = format!("{}/prism-workspace", os_tmpdir());
        let result = prepare_local_workspace();

        assert_eq!(
            result,
            PreparedWorkspace {
                root: fallback.clone(),
                fell_back_from: Some(path_resolve(&desired))
            }
        );
        // Pins the fallback so every later resolve_local_workspace_root() agrees.
        assert_eq!(
            std::env::var("SHELL_WORKSPACE_ROOT").unwrap(),
            fallback
        );
        assert!(std::path::Path::new(&fallback).is_dir());
    }
}
