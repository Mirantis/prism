//! Single source of truth for the persistent **data directory** — the place
//! that survives container/process restarts and holds the agent's durable
//! state. Today that location is implicit in `DATABASE_URL` (set per context:
//! `/data` in the container via start.sh, `~/.prism` for the SEA binary via
//! server-entry.ts). This module makes it explicit so anything that needs a
//! persistent home (skills, plugins, the coding agent's config dir) derives
//! from one place.

use anyhow::Context;

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
    try_ensure_symlink(target, link_path).unwrap_or(false)
}

fn try_ensure_symlink(target: &str, link_path: &str) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(link_path) {
        Ok(st) => {
            if st.file_type().is_symlink() {
                if std::fs::read_link(link_path)?.as_os_str() == std::ffi::OsStr::new(target) {
                    return Ok(true); // already correct
                }
                remove_link(link_path)?;
            } else if st.is_dir() {
                if std::fs::read_dir(link_path)?.next().is_some() {
                    return Ok(false); // populated — leave it
                }
                std::fs::remove_dir(link_path)?;
            } else {
                std::fs::remove_file(link_path)?;
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    create_dir_link(target, link_path)?;
    Ok(true)
}

/// `fs.unlinkSync` of a symlink.
fn remove_link(link_path: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // A directory link on Windows is removed as a directory.
        if std::fs::remove_dir(link_path).is_ok() {
            return Ok(());
        }
    }
    std::fs::remove_file(link_path)
}

/// `fs.symlinkSync(target, linkPath)`: a POSIX symlink, or on Windows a directory
/// link, which Node makes as a junction.
fn create_dir_link(target: &str, link_path: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link_path)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link_path)
    }
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
    let desired = resolve_data_dir();
    let mut data_dir = desired.clone();
    let mut fell_back_from = None;
    if std::fs::create_dir_all(&desired).is_err() {
        let fallback = join_path(&tmp_dir(), "prism-data");
        std::fs::create_dir_all(&fallback)
            .with_context(|| format!("failed to create the data dir {fallback}"))?;
        // SAFETY: called once at startup, before any tool or task reads the
        // environment concurrently.
        unsafe { std::env::set_var("PRISM_DATA_DIR", &fallback) }; // pin so all resolvers agree
        data_dir = fallback;
        fell_back_from = Some(desired);
    }

    let skills_dir = resolve_skills_dir();
    let plugins_dir = resolve_plugins_dir();
    let media_dir = resolve_media_dir();
    let tool_output_dir = resolve_tool_output_dir();
    for dir in [&skills_dir, &plugins_dir, &media_dir, &tool_output_dir] {
        std::fs::create_dir_all(dir).with_context(|| format!("failed to create {dir}"))?;
    }

    Ok(DataDirsSetup {
        data_dir,
        skills_dir,
        plugins_dir,
        media_dir,
        tool_output_dir,
        fell_back_from,
    })
}

/// `os.tmpdir()`.
fn tmp_dir() -> String {
    let dir = std::env::temp_dir().to_string_lossy().into_owned();
    match dir.strip_suffix(std::path::MAIN_SEPARATOR) {
        Some(stripped) if !stripped.is_empty() => stripped.to_string(),
        _ => dir,
    }
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

use crate::support::path::resolve as resolve_path;

/// `path.join(base, name)` for an absolute `base`.
fn join_path(base: &str, name: &str) -> String {
    #[cfg(windows)]
    {
        return std::path::Path::new(base)
            .join(name)
            .to_string_lossy()
            .into_owned();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const ENV_KEYS: [&str; 3] = ["PRISM_DATA_DIR", "PRISM_SKILLS_DIR", "PRISM_PLUGINS_DIR"];

    /// Clears the variables the resolvers read for one test, and puts them back.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
        tmp: tempfile::TempDir,
    }

    impl EnvGuard {
        fn new() -> EnvGuard {
            let saved = ENV_KEYS
                .iter()
                .map(|k| (*k, std::env::var(k).ok()))
                .collect();
            for k in ENV_KEYS {
                // SAFETY: the tests that touch the environment run serially.
                unsafe { std::env::remove_var(k) };
            }
            let tmp = tempfile::Builder::new()
                .prefix("prism-datadir-test-")
                .tempdir()
                .unwrap();
            EnvGuard { saved, tmp }
        }

        fn tmp(&self) -> String {
            self.tmp.path().to_string_lossy().into_owned()
        }

        fn set(&self, key: &str, value: &str) {
            // SAFETY: the tests that touch the environment run serially.
            unsafe { std::env::set_var(key, value) };
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                // SAFETY: the tests that touch the environment run serially.
                unsafe {
                    match v {
                        Some(v) => std::env::set_var(k, v),
                        None => std::env::remove_var(k),
                    }
                }
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn honors_prism_data_dir_over_everything_else() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        assert_eq!(resolve_data_dir(), resolve_path(&g.tmp()));
    }

    #[test]
    #[serial_test::serial]
    fn falls_back_to_home_prism_when_prism_data_dir_is_unset() {
        let _g = EnvGuard::new();
        assert_eq!(resolve_data_dir(), join_path(&home_dir(), ".prism"));
    }

    #[test]
    #[serial_test::serial]
    fn skills_and_media_dirs_derive_from_the_data_dir() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        assert_eq!(resolve_skills_dir(), format!("{}/skills", g.tmp()));
        assert_eq!(resolve_media_dir(), format!("{}/media", g.tmp()));
    }

    #[test]
    #[serial_test::serial]
    fn honors_prism_skills_dir_override() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        let custom = format!("{}/elsewhere", g.tmp());
        g.set("PRISM_SKILLS_DIR", &custom);
        assert_eq!(resolve_skills_dir(), custom);
    }

    #[test]
    #[serial_test::serial]
    fn plugins_dir_derives_from_the_data_dir() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        assert_eq!(resolve_plugins_dir(), format!("{}/plugins", g.tmp()));
    }

    #[test]
    #[serial_test::serial]
    fn honors_prism_plugins_dir_override() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        let custom = format!("{}/elsewhere", g.tmp());
        g.set("PRISM_PLUGINS_DIR", &custom);
        assert_eq!(resolve_plugins_dir(), custom);
    }

    #[test]
    #[serial_test::serial]
    fn ensure_data_dirs_creates_the_skills_plugins_media_and_tool_output_dirs() {
        let g = EnvGuard::new();
        g.set("PRISM_DATA_DIR", &g.tmp());
        let r = ensure_data_dirs().unwrap();

        assert_eq!(r.fell_back_from, None);
        assert_eq!(r.data_dir, resolve_path(&g.tmp()));
        assert_eq!(r.skills_dir, format!("{}/skills", g.tmp()));
        assert_eq!(r.plugins_dir, format!("{}/plugins", g.tmp()));
        assert_eq!(r.media_dir, format!("{}/media", g.tmp()));
        assert_eq!(r.tool_output_dir, format!("{}/tool-outputs", g.tmp()));
        for dir in [
            &r.skills_dir,
            &r.plugins_dir,
            &r.media_dir,
            &r.tool_output_dir,
        ] {
            assert!(std::fs::metadata(dir).unwrap().is_dir());
        }
    }

    fn realpath(p: &str) -> std::path::PathBuf {
        std::fs::canonicalize(p).unwrap()
    }

    #[test]
    fn ensure_symlink_creates_the_link_and_reports_it_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target").to_string_lossy().into_owned();
        let link = tmp.path().join("link").to_string_lossy().into_owned();
        std::fs::create_dir(&target).unwrap();

        assert!(ensure_symlink(&target, &link));
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(realpath(&link), realpath(&target));
    }

    #[test]
    fn ensure_symlink_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target").to_string_lossy().into_owned();
        let link = tmp.path().join("link").to_string_lossy().into_owned();
        std::fs::create_dir(&target).unwrap();

        ensure_symlink(&target, &link);
        assert!(ensure_symlink(&target, &link));
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(realpath(&link), realpath(&target));
    }

    #[test]
    fn ensure_symlink_does_not_clobber_a_populated_real_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target").to_string_lossy().into_owned();
        let link = tmp.path().join("link");
        std::fs::create_dir(&target).unwrap();
        std::fs::create_dir(&link).unwrap();
        std::fs::write(link.join("keep.txt"), "x").unwrap();
        let link = link.to_string_lossy().into_owned();

        assert!(!ensure_symlink(&target, &link));
        // The content that was there survives: a directory this did not make is never deleted.
        assert!(std::path::Path::new(&link).join("keep.txt").exists());
        assert!(
            !std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
