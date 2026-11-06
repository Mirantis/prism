//! Download, verify and install one release into a standalone (SEA) install.
//!
//! The install root is the directory holding the running binary (~/.prism).
//! A release is staged under `<installRoot>/updates/<version>/` — the same
//! filesystem as the install, so activation is a handful of atomic renames:
//! current entry → `.update-trash/`, staged entry → current. The running
//! process keeps its open inodes, so the swap never touches it; the caller
//! exits afterwards and the service supervisor (launchd KeepAlive / systemd
//! Restart=always) respawns the new binary.
//!
//! Windows needs a second process for it. This runtime cannot stop its own
//! Scheduled Task, restart it, and still be around to report the outcome, and
//! the task restarts only on failure rather than on any exit — so there the
//! staged `install.ps1` is spawned detached: it stops the task and the server,
//! swaps the install by the same rename-aside-and-roll-back method used here,
//! re-registers the task and starts it again. `prism.exe` is deliberately left
//! running, since a self-update is usually driven by it.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::constants::UPDATE_GITHUB_REPO;
use crate::{log_debug, log_error};

/// Whole-archive download budget; the archives are ~100-200 MB.
const DOWNLOAD_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS: u64 = 60 * 1000;

/// What went wrong, kept narrow enough that a stored code points at one cause.
/// `VerifyFailed` means the bytes really were wrong; a missing checksum or a
/// failed extraction get their own codes, because reading either as "the bytes
/// were wrong" sends whoever is diagnosing it the wrong way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateErrorCode {
    DownloadFailed,
    AssetNotFound,
    ChecksumUnavailable,
    ExtractFailed,
    ProbeFailed,
    VerifyFailed,
    SwapFailed,
    SpawnFailed,
}

impl UpdateErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateErrorCode::DownloadFailed => "download_failed",
            UpdateErrorCode::AssetNotFound => "asset_not_found",
            UpdateErrorCode::ChecksumUnavailable => "checksum_unavailable",
            UpdateErrorCode::ExtractFailed => "extract_failed",
            UpdateErrorCode::ProbeFailed => "probe_failed",
            UpdateErrorCode::VerifyFailed => "verify_failed",
            UpdateErrorCode::SwapFailed => "swap_failed",
            UpdateErrorCode::SpawnFailed => "spawn_failed",
        }
    }
}

impl std::fmt::Display for UpdateErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A failed update step, with the code an attempt row records. Returned inside
/// `anyhow::Error`; callers downcast to read the code.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct UpdateError {
    pub code: UpdateErrorCode,
    pub message: String,
}

impl UpdateError {
    pub fn new(code: UpdateErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The directory the running binary was installed into (~/.prism).
pub fn install_root() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

/// Node's `process.platform`: `darwin`, `linux`, `win32`, …
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node's `process.arch`: `x64`, `arm64`, …
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `<platform>-<arch>` as the release assets name it.
fn os_arch() -> String {
    format!("{}-{}", node_platform(), node_arch())
}

/// Download and verify one release. Returns the staged dist directory
/// (`<installRoot>/updates/<version>/<platform>-<arch>`) ready to activate.
/// `root` defaults to `install_root()`.
///
/// A stage left by a deferred automatic apply (the agent was busy after the
/// download) is reused rather than re-downloaded — a few hundred MB every
/// tick while the agent stays busy would be waste.
///
/// What that reuse re-checks is the layout and the binary's own reported
/// version, not the checksum: the archive it was verified from is deleted
/// straight after extraction. So this trusts that nothing rewrote the staged
/// files since. That is not a privilege boundary — the staging dir sits in
/// the install root, which is user-writable and already holds the running
/// binary — so anything able to tamper with it can edit the binary directly.
///
/// Otherwise the staging dir is recreated, the asset
/// `prism-<version>-<platform>-<arch>.<zip on win32, else tar.gz>` is downloaded
/// from `https://github.com/<repo>/releases/download/<version>/<asset>`, its
/// checksum verified, extracted and deleted; the dist must hold `prism`
/// (`prism.exe`), `prism-server` (`prism-server.exe`), `node_modules` and `web`
/// (else `verify_failed`: `archive is missing <name>`), and the staged server
/// must report `version`.
pub async fn stage_release(version: &str, root: Option<&str>) -> anyhow::Result<String> {
    todo!()
}

/// A previously staged dist for `version`, when its binary still verifies.
async fn verified_staged_dist(staging_root: &str, version: &str) -> Option<String> {
    todo!()
}

/// The staged binary must identify as the target version — catches a wrong or
/// corrupt asset before anything is activated. Runs `<binary> --version` within
/// `PROBE_TIMEOUT_MS`; a failed run is `probe_failed` (`staged prism-server
/// --version failed: <message>`), a different trimmed output `verify_failed`
/// (`staged prism-server reports <reported>, expected <version>`).
async fn probe_staged_version(server_binary: &str, version: &str) -> anyhow::Result<()> {
    todo!()
}

/// Activate a staged release on macOS/Linux: rename each current entry into
/// `.update-trash/<ts>/` and the staged entry into place. On a mid-swap
/// failure every completed rename is reversed, so the install is never left
/// half-swapped. The caller exits the process afterwards. `root` defaults to
/// `install_root()`.
///
/// Four renames, not one (`node_modules`, `web`, `prism`, `prism-server`, in that
/// order): a host crash inside that window can leave a mixed install that needs a
/// re-run of the installer. Named trade — a single-root activation needs the whole
/// install layout rebuilt around a versioned code dir (install.sh, the launcher
/// symlink, the service definitions), and the window here is a few renames on one
/// filesystem.
///
/// A rollback rename that fails logs `[Update] rollback of <entry> failed` (error
/// under `err`); the swap then fails with `swap_failed` (`swap failed: <message>`).
pub fn swap_install(dist_dir: &str, root: Option<&str>) -> anyhow::Result<()> {
    todo!()
}

/// Activate a staged release on Windows: run the staged install.ps1 detached.
/// It stops the PrismServer task and process, copies the staged files,
/// re-registers the task and starts it — this process is killed by it, so the
/// pending attempt row is resolved by the next boot.
///
/// No `install.ps1` is `spawn_failed` (`staged archive has no install.ps1`).
/// `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>` runs
/// detached with stdout and stderr appended to
/// `<installRoot>/updates/update-<version>.log`, and with `PRISM_DIST` and
/// `PRISM_HOME` set explicitly: the scheduled server's environment does not keep
/// the installer-time value, and without it the staged installer would default
/// to `%USERPROFILE%\.prism` and update the wrong install. A start failure is
/// `spawn_failed` (`could not start install.ps1: <message>`).
pub async fn spawn_windows_installer(dist_dir: &str, version: &str) -> anyhow::Result<()> {
    todo!()
}

/// Remove one release's staged download. Best-effort, run on a failed apply;
/// a failure logs `[Update] cleanup of staged <version> failed: <message>` at
/// debug. `root` defaults to `install_root()`.
pub fn remove_staged_release(version: &str, root: Option<&str>) {
    todo!()
}

/// Remove staging and trash leftovers (`updates`, `.update-trash`). Best-effort,
/// run at every boot; a failure logs `[Update] sweep of <dir> failed: <message>`
/// at debug. `root` defaults to `install_root()`.
pub fn sweep_update_dirs(root: Option<&str>) {
    todo!()
}

/// Download `url` (following redirects, within `DOWNLOAD_TIMEOUT_MS`) to `dest`.
/// A 404 is `asset_not_found` (`release asset not published yet: <url>`): the GHCR
/// tag is pushed before the release assets are attached, so a brand-new version
/// can 404 here for a few minutes, and it is retryable. Any other failure is
/// `download_failed` (`download failed: <message>`, `download failed with
/// <status>: <url>`, `download stream failed: <message>`).
async fn download_to(url: &str, dest: &str) -> anyhow::Result<()> {
    todo!()
}

/// Verify the archive against its published `.sha256` asset. Fails closed:
/// every release the updater can install is newer than the release that
/// introduced the checksum step, so a missing, malformed or unfetchable
/// checksum means an unverifiable archive, not an old one. A transient
/// registry failure records `verify_failed` and the next tick retries.
///
/// The checksum fetch gets 30 s; its failure is `checksum_unavailable`
/// (`checksum fetch failed: <message>`), and so is a first whitespace-separated
/// token that is not 64 lowercase hex digits (`no valid sha256 published at
/// <url>.sha256`). A mismatch is `verify_failed` (`archive sha256 <actual> does
/// not match published <expected>`).
async fn verify_checksum(asset_url: &str, archive_path: &str) -> anyhow::Result<()> {
    todo!()
}

/// Extract with the system `tar` (`-xzf`, or `-xf` on Windows, where bsdtar also
/// reads .zip archives) within `EXTRACT_TIMEOUT_MS`; a failure is
/// `extract_failed` (`archive extraction failed: <message>`).
async fn extract(archive_path: &str, dest_dir: &str) -> anyhow::Result<()> {
    todo!()
}
