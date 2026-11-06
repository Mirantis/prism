//! The standalone install's defaults, applied by `main` before the runtime boots.
//!
//! A release build (`is_sea()`) runs without `start.sh`, so it fills in what that
//! script sets for the container: the database under `~/.prism`, the web UI next to
//! the executable, and a workspace root that exists. Each default applies only when
//! the operator or service has not set the variable. A staged `.prism` restore is
//! promoted before anything opens the database.

use std::path::PathBuf;

/// Sets the standalone defaults. Runs before any thread starts, because it writes
/// the process environment.
pub fn apply_standalone_defaults() -> anyhow::Result<()> {
    let data_dir = home_dir().join(".prism");
    std::fs::create_dir_all(&data_dir)?;
    let exe_dir = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();

    set_default("NODE_ENV", "production".into());
    set_default("DATABASE_URL", format!("file:{}", data_dir.join("agent.db").display()));
    set_default("PRISM_WEB_DIR", exe_dir.join("web").display().to_string());
    set_default("SHELL_WORKSPACE_ROOT", data_dir.join("workspace").display().to_string());

    // A missing cwd makes tool subprocess spawns fail with ENOENT.
    if let Some(root) = std::env::var_os("SHELL_WORKSPACE_ROOT").filter(|v| !v.is_empty()) {
        std::fs::create_dir_all(root)?;
    }
    crate::scripts::apply_pending_import::apply_pending_import()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `process.env.NAME ??= value`: an empty string counts as set.
fn set_default(name: &str, value: String) {
    if std::env::var_os(name).is_none() {
        // SAFETY: called from `main` before the async runtime or any other thread starts.
        unsafe { std::env::set_var(name, value) };
    }
}
