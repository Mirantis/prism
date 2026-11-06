//! Single source of truth for the persistent **data directory** — the place
//! that survives container/process restarts and holds the agent's durable
//! state. Today that location is implicit in `DATABASE_URL` (set per context:
//! `/data` in the container via start.sh, `~/.prism` for the SEA binary via
//! server-entry.ts). This module makes it explicit so anything that needs a
//! persistent home (skills, plugins, the coding agent's config dir) derives
//! from one place.

/// Resolve the persistent data dir.
///
///  1. `PRISM_DATA_DIR` when set — the container image bakes
///     `PRISM_DATA_DIR=/data` (the mounted volume), so in-container this is `/data`.
///     It's also the pin set by the temp-dir fallback below so every resolver
///     agrees within a process, and an operator can override it.
///  2. `~/.prism` — everywhere else (local dev, the packaged SEA binary, which
///     also keeps its DB under `~/.prism`).
pub fn resolve_data_dir() -> String {
    if let Some(dir) = env_trimmed("PRISM_DATA_DIR") {
        return resolve_path(&dir);
    }
    join_path(&home_dir(), ".prism")
}

/// Canonical, tool-agnostic skills directory. Overridable via `PRISM_SKILLS_DIR`.
pub fn resolve_skills_dir() -> String {
    if let Some(dir) = env_trimmed("PRISM_SKILLS_DIR") {
        return resolve_path(&dir);
    }
    join_path(&resolve_data_dir(), "skills")
}

/// Canonical Agent Plugins directory. Overridable via `PRISM_PLUGINS_DIR`.
pub fn resolve_plugins_dir() -> String {
    if let Some(dir) = env_trimmed("PRISM_PLUGINS_DIR") {
        return resolve_path(&dir);
    }
    join_path(&resolve_data_dir(), "plugins")
}

/// Media directory for attachment content (`/data/media` in the container).
/// Attachment bytes live here as files — the DB row keeps only metadata plus
/// the file's basename (see `lib/media_store.rs`, the sole reader/writer).
pub fn resolve_media_dir() -> String {
    join_path(&resolve_data_dir(), "media")
}

/// Where an oversized tool result is saved so the omitted middle stays reachable
/// (`/data/tool-outputs` in the container). Files only — no DB row points at one,
/// so a spill's whole lifecycle is its mtime against the TTL. See
/// `lib/tool_output_store.rs`, the sole reader/writer.
pub fn resolve_tool_output_dir() -> String {
    join_path(&resolve_data_dir(), "tool-outputs")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirsSetup {
    pub data_dir: String,
    pub skills_dir: String,
    pub plugins_dir: String,
    pub media_dir: String,
    pub tool_output_dir: String,
    /// The intended data dir we couldn't create (so the caller can warn), else `None`.
    pub fell_back_from: Option<String>,
}

/// Idempotently create a symlink at `link_path` pointing to `target`. Returns
/// whether the link is in place afterwards. A real (non-symlink) directory at
/// `link_path` is only replaced when empty — we never delete a populated dir we
/// didn't create.
pub fn ensure_symlink(target: &str, link_path: &str) -> bool {
    todo!()
}

/// Ensure the data dir and the canonical skills, plugins, media and tool-output
/// dirs exist. The coding agent's own home inside the data dir is the adapter's
/// business (`CodingAgent::prepare_home`), run by `index.rs` right after this.
///
/// Mirrors `ensure_workspace_root()`'s temp-dir fallback: when the intended data
/// dir can't be created (e.g. `/data` on a local macOS run), fall back to a
/// writable temp dir (`<tmpdir>/prism-data`) and pin it via `PRISM_DATA_DIR` so
/// every subsequent resolve agrees. Called once at startup, before any tool can
/// spawn. Fails when the fallback or one of the canonical dirs cannot be created.
pub fn ensure_data_dirs() -> anyhow::Result<DataDirsSetup> {
    todo!()
}

/// An environment variable, trimmed; `None` when unset or blank.
fn env_trimmed(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `os.homedir()`.
#[allow(deprecated)]
fn home_dir() -> String {
    std::env::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `path.resolve(p)`: absolute against the working directory, then normalized.
fn resolve_path(path: &str) -> String {
    if path.starts_with('/') {
        return normalize(path);
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    normalize(&format!("{cwd}/{path}"))
}

/// `path.join(base, name)` for an absolute `base`.
fn join_path(base: &str, name: &str) -> String {
    normalize(&format!("{base}/{name}"))
}

/// Lexical normalization of an absolute POSIX path: no `.`, no `..`, no empty
/// segments, no trailing slash.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}
