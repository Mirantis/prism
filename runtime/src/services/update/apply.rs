//! Download, verify and install one release into a standalone install.
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

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::constants::UPDATE_GITHUB_REPO;
use crate::{log_debug, log_error};

/// Whole-archive download budget; the archives are ~100-200 MB.
const DOWNLOAD_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS: u64 = 60 * 1000;
const CHECKSUM_TIMEOUT_MS: u64 = 30_000;

/// Where the release assets are published.
const RELEASES_HOST: &str = "https://github.com";

/// The entries a release puts in the install root, in the order the swap
/// activates them.
const SWAP_ENTRIES: [&str; 3] = ["web", "prism", "prism-server"];

/// The `node_modules/` sidecar an earlier runtime loaded; this one needs none.
const LEGACY_SIDECAR: &str = "node_modules";

/// The download client: follows redirects. No proxy, as Node's `fetch` uses none.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("the release download client builds")
});

static SHA256_HEX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}$").expect("valid regex"));

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

fn update_error(code: UpdateErrorCode, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(UpdateError::new(code, message))
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
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node's `process.arch`: `x64`, `arm64`, …
pub fn node_arch() -> &'static str {
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

fn is_windows() -> bool {
    cfg!(windows)
}

fn server_binary_name() -> &'static str {
    if is_windows() {
        "prism-server.exe"
    } else {
        "prism-server"
    }
}

fn client_binary_name() -> &'static str {
    if is_windows() { "prism.exe" } else { "prism" }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `rmSync(path, { recursive: true, force: true })`: a missing path is fine.
fn remove_all(path: &Path) -> std::io::Result<()> {
    let removed = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(err) => Err(err),
    };
    match removed {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Download and verify one release. Returns the staged dist directory
/// (`<installRoot>/updates/<version>/<platform>-<arch>`) ready to activate.
/// `root` defaults to `install_root()`.
pub async fn stage_release(version: &str, root: Option<&str>) -> anyhow::Result<String> {
    let root = root.map(str::to_string).unwrap_or_else(install_root);
    stage_release_from(RELEASES_HOST, version, &root).await
}

/// [`stage_release`] with the assets read from `releases_host`.
async fn stage_release_from(
    releases_host: &str,
    version: &str,
    root: &str,
) -> anyhow::Result<String> {
    let staging_root = Path::new(root).join("updates").join(version);

    // A stage left by a deferred automatic apply (the agent was busy after the
    // download) is reused rather than re-downloaded — a few hundred MB every
    // tick while the agent stays busy would be waste.
    //
    // What that reuse re-checks is the layout and the binary's own reported
    // version, not the checksum: the archive it was verified from is deleted
    // straight after extraction. So this trusts that nothing rewrote the staged
    // files since. That is not a privilege boundary — the staging dir sits in
    // the install root, which is user-writable and already holds the running
    // binary — so anything able to tamper with it can edit the binary directly.
    if let Some(existing) = verified_staged_dist(&path_text(&staging_root), version).await {
        return Ok(existing);
    }

    remove_all(&staging_root)?;
    std::fs::create_dir_all(&staging_root)?;

    let extension = if is_windows() { "zip" } else { "tar.gz" };
    let asset = format!("prism-{version}-{}.{extension}", os_arch());
    let asset_url =
        format!("{releases_host}/{UPDATE_GITHUB_REPO}/releases/download/{version}/{asset}");
    let archive_path = staging_root.join(&asset);

    download_to(&asset_url, &path_text(&archive_path)).await?;
    verify_checksum(&asset_url, &path_text(&archive_path)).await?;
    extract(&path_text(&archive_path), &path_text(&staging_root)).await?;
    remove_all(&archive_path)?;

    let dist_dir = staging_root.join(os_arch());
    let server_binary = dist_dir.join(server_binary_name());
    let expected = [
        dist_dir.join(client_binary_name()),
        server_binary.clone(),
        dist_dir.join("web"),
    ];
    for entry in &expected {
        if !entry.exists() {
            return Err(update_error(
                UpdateErrorCode::VerifyFailed,
                format!("archive is missing {}", base_name(entry)),
            ));
        }
    }

    probe_staged_version(&path_text(&server_binary), version).await?;
    Ok(path_text(&dist_dir))
}

/// A previously staged dist for `version`, when its binary still verifies.
async fn verified_staged_dist(staging_root: &str, version: &str) -> Option<String> {
    let dist_dir = Path::new(staging_root).join(os_arch());
    let server_binary = dist_dir.join(server_binary_name());
    if !server_binary.exists() {
        return None;
    }
    probe_staged_version(&path_text(&server_binary), version)
        .await
        .ok()?;
    Some(path_text(&dist_dir))
}

/// The staged binary must identify as the target version — catches a wrong or
/// corrupt asset before anything is activated.
async fn probe_staged_version(server_binary: &str, version: &str) -> anyhow::Result<()> {
    let reported = match run_version(server_binary).await {
        Ok(stdout) => crate::support::js::trim(&stdout).to_string(),
        Err(err) => {
            return Err(update_error(
                UpdateErrorCode::ProbeFailed,
                format!("staged prism-server --version failed: {err}"),
            ));
        }
    };
    if reported != version {
        return Err(update_error(
            UpdateErrorCode::VerifyFailed,
            format!("staged prism-server reports {reported}, expected {version}"),
        ));
    }
    Ok(())
}

/// `<binary> --version`'s stdout, within `PROBE_TIMEOUT_MS`. A run that fails or
/// exits non-zero is an error worded as `execFile` words it.
async fn run_version(server_binary: &str) -> anyhow::Result<String> {
    let mut command = tokio::process::Command::new(server_binary);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_millis(PROBE_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Command failed: {server_binary} --version"))??;
    if !output.status.success() {
        anyhow::bail!(
            "Command failed: {server_binary} --version\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Activate a staged release on macOS/Linux: rename each current entry into
/// `.update-trash/<ts>/` and the staged entry into place. On a mid-swap
/// failure every completed rename is reversed, so the install is never left
/// half-swapped. The caller exits the process afterwards. `root` defaults to
/// `install_root()`.
///
/// Three renames, not one (`web`, `prism`, `prism-server`, in that order): a host
/// crash inside that window can leave a mixed install that needs a re-run of the
/// installer. Named trade — a single-root activation needs the whole install
/// layout rebuilt around a versioned code dir (install.sh, the launcher symlink,
/// the service definitions), and the window here is a few renames on one
/// filesystem. Once every entry is in place, an old install's `node_modules/`
/// moves into the trash too.
pub fn swap_install(dist_dir: &str, root: Option<&str>) -> anyhow::Result<()> {
    let root = PathBuf::from(root.map(str::to_string).unwrap_or_else(install_root));
    let dist_dir = Path::new(dist_dir);
    let trash_dir = root
        .join(".update-trash")
        .join(crate::support::now_ms().to_string());
    std::fs::create_dir_all(&trash_dir)?;

    let mut done: Vec<&str> = Vec::new();
    // The entry whose current copy is already in the trash while its staged
    // replacement has not landed yet — the one state the done-list can't see.
    let mut in_flight: Option<&str> = None;
    let swapped: std::io::Result<()> = (|| {
        for entry in SWAP_ENTRIES {
            let current = root.join(entry);
            if current.exists() {
                std::fs::rename(&current, trash_dir.join(entry))?;
                in_flight = Some(entry);
            }
            std::fs::rename(dist_dir.join(entry), &current)?;
            in_flight = None;
            done.push(entry);
        }
        Ok(())
    })();

    if let Err(error) = swapped {
        if let Some(entry) = in_flight {
            if let Err(rollback_error) = std::fs::rename(trash_dir.join(entry), root.join(entry)) {
                log_rollback_failure(entry, rollback_error);
            }
        }
        for entry in done.iter().rev() {
            let restored: std::io::Result<()> = (|| {
                std::fs::rename(root.join(entry), dist_dir.join(entry))?;
                let trashed = trash_dir.join(entry);
                if trashed.exists() {
                    std::fs::rename(&trashed, root.join(entry))?;
                }
                Ok(())
            })();
            if let Err(rollback_error) = restored {
                log_rollback_failure(entry, rollback_error);
            }
        }
        return Err(update_error(
            UpdateErrorCode::SwapFailed,
            format!("swap failed: {error}"),
        ));
    }

    let sidecar = root.join(LEGACY_SIDECAR);
    if sidecar.exists() {
        if let Err(error) = std::fs::rename(&sidecar, trash_dir.join(LEGACY_SIDECAR)) {
            log_debug!(
                "[Update] cleanup of {} failed: {}",
                path_text(&sidecar),
                error
            );
        }
    }
    Ok(())
}

fn log_rollback_failure(entry: &str, error: std::io::Error) {
    let error = anyhow::Error::new(error);
    log_error!(
        serde_json::json!({ "err": crate::lib::log_redaction::err_json(&error) }),
        "[Update] rollback of {} failed",
        entry
    );
}

/// Activate a staged release on Windows: run the staged install.ps1 detached.
/// It stops the PrismServer task and process, copies the staged files,
/// re-registers the task and starts it — this process is killed by it, so the
/// pending attempt row is resolved by the next boot.
pub async fn spawn_windows_installer(dist_dir: &str, version: &str) -> anyhow::Result<()> {
    let script = Path::new(dist_dir).join("install.ps1");
    if !script.exists() {
        return Err(update_error(
            UpdateErrorCode::SpawnFailed,
            "staged archive has no install.ps1",
        ));
    }
    spawn_installer(dist_dir, version, &script).map_err(|error| {
        update_error(
            UpdateErrorCode::SpawnFailed,
            format!("could not start install.ps1: {error}"),
        )
    })
}

fn spawn_installer(dist_dir: &str, version: &str, script: &Path) -> anyhow::Result<()> {
    let log_path = Path::new(&install_root())
        .join("updates")
        .join(format!("update-{version}.log"));
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        // PRISM_HOME explicitly: the scheduled server's environment does not
        // keep the installer-time value, and without it the staged installer
        // would default to %USERPROFILE%\.prism and update the wrong install.
        .env("PRISM_DIST", dist_dir)
        .env("PRISM_HOME", install_root());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    // The child is left running on its own; dropping the handle neither waits
    // for it nor stops it.
    command.spawn()?;
    Ok(())
}

/// Remove one release's staged download. Best-effort, run on a failed apply.
/// `root` defaults to `install_root()`.
pub fn remove_staged_release(version: &str, root: Option<&str>) {
    let root = root.map(str::to_string).unwrap_or_else(install_root);
    if let Err(error) = remove_all(&Path::new(&root).join("updates").join(version)) {
        log_debug!("[Update] cleanup of staged {} failed: {}", version, error);
    }
}

/// Remove staging and trash leftovers. Best-effort, run at every boot. `root`
/// defaults to `install_root()`.
pub fn sweep_update_dirs(root: Option<&str>) {
    let root = PathBuf::from(root.map(str::to_string).unwrap_or_else(install_root));
    for dir in [root.join("updates"), root.join(".update-trash")] {
        if let Err(error) = remove_all(&dir) {
            log_debug!("[Update] sweep of {} failed: {}", path_text(&dir), error);
        }
    }
}

async fn download_to(url: &str, dest: &str) -> anyhow::Result<()> {
    let res = CLIENT
        .get(url)
        .timeout(Duration::from_millis(DOWNLOAD_TIMEOUT_MS))
        .send()
        .await
        .map_err(|error| {
            update_error(
                UpdateErrorCode::DownloadFailed,
                format!("download failed: {error}"),
            )
        })?;
    if res.status().as_u16() == 404 {
        // The GHCR tag is pushed before the release assets are attached, so a
        // brand-new version can 404 here for a few minutes. Retryable.
        return Err(update_error(
            UpdateErrorCode::AssetNotFound,
            format!("release asset not published yet: {url}"),
        ));
    }
    if !res.status().is_success() {
        return Err(update_error(
            UpdateErrorCode::DownloadFailed,
            format!("download failed with {}: {url}", res.status().as_u16()),
        ));
    }
    let streamed: anyhow::Result<()> = async {
        let mut file = tokio::fs::File::create(dest).await?;
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        Ok(())
    }
    .await;
    streamed.map_err(|error| {
        update_error(
            UpdateErrorCode::DownloadFailed,
            format!("download stream failed: {error}"),
        )
    })
}

/// Verify the archive against its published `.sha256` asset. Fails closed:
/// every release the updater can install is newer than the release that
/// introduced the checksum step, so a missing, malformed or unfetchable
/// checksum means an unverifiable archive, not an old one. A transient
/// registry failure records `verify_failed` and the next tick retries.
async fn verify_checksum(asset_url: &str, archive_path: &str) -> anyhow::Result<()> {
    let fetched: anyhow::Result<Option<String>> = async {
        let res = CLIENT
            .get(format!("{asset_url}.sha256"))
            .timeout(Duration::from_millis(CHECKSUM_TIMEOUT_MS))
            .send()
            .await?;
        if !res.status().is_success() {
            return Ok(None);
        }
        let text = res.text().await?;
        Ok(crate::support::js::trim(&text)
            .split(|c: char| crate::support::js::is_js_whitespace(c))
            .next()
            .map(str::to_lowercase))
    }
    .await;
    let expected = fetched.map_err(|error| {
        update_error(
            UpdateErrorCode::ChecksumUnavailable,
            format!("checksum fetch failed: {error}"),
        )
    })?;
    let Some(expected) = expected.filter(|hash| SHA256_HEX_RE.is_match(hash)) else {
        return Err(update_error(
            UpdateErrorCode::ChecksumUnavailable,
            format!("no valid sha256 published at {asset_url}.sha256"),
        ));
    };

    let actual = sha256_file(archive_path).await?;
    if actual != expected {
        return Err(update_error(
            UpdateErrorCode::VerifyFailed,
            format!("archive sha256 {actual} does not match published {expected}"),
        ));
    }
    Ok(())
}

async fn sha256_file(path: &str) -> anyhow::Result<String> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await?
}

async fn extract(archive_path: &str, dest_dir: &str) -> anyhow::Result<()> {
    // System tar handles .tar.gz everywhere; on Windows 10+ bsdtar also reads
    // .zip archives.
    let flags = if is_windows() { "-xf" } else { "-xzf" };
    let mut command = tokio::process::Command::new("tar");
    command
        .args([flags, archive_path, "-C", dest_dir])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let outcome = tokio::time::timeout(Duration::from_millis(EXTRACT_TIMEOUT_MS), command.output())
        .await;
    let failure = match outcome {
        Err(_) => Some(format!(
            "Command failed: tar {flags} {archive_path} -C {dest_dir}"
        )),
        Ok(Err(error)) => Some(error.to_string()),
        Ok(Ok(output)) if !output.status.success() => Some(format!(
            "Command failed: tar {flags} {archive_path} -C {dest_dir}\n{}",
            String::from_utf8_lossy(&output.stderr)
        )),
        Ok(Ok(_)) => None,
    };
    match failure {
        Some(message) => Err(update_error(
            UpdateErrorCode::ExtractFailed,
            format!("archive extraction failed: {message}"),
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(error: &anyhow::Error) -> Option<UpdateErrorCode> {
        error.downcast_ref::<UpdateError>().map(|e| e.code)
    }

    struct Install {
        _dir: tempfile::TempDir,
        root: PathBuf,
        dist_dir: PathBuf,
    }

    fn write_install(dir: &Path, marker: &str) {
        std::fs::create_dir_all(dir.join("web")).unwrap();
        std::fs::write(dir.join("web").join("index.html"), marker).unwrap();
        std::fs::write(dir.join("prism"), marker).unwrap();
        std::fs::write(dir.join("prism-server"), marker).unwrap();
    }

    fn install() -> Install {
        let dir = tempfile::Builder::new()
            .prefix("prism-update-root-")
            .tempdir()
            .unwrap();
        let root = dir.path().to_path_buf();
        let dist_dir = root
            .join("updates")
            .join("v2026.8.24083158")
            .join("darwin-arm64");
        write_install(&root, "old");
        std::fs::create_dir_all(&dist_dir).unwrap();
        write_install(&dist_dir, "new");
        Install {
            _dir: dir,
            root,
            dist_dir,
        }
    }

    fn read(path: PathBuf) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn activates_the_staged_entries_and_keeps_the_old_ones_in_the_trash() {
        let install = install();
        swap_install(
            &path_text(&install.dist_dir),
            Some(&path_text(&install.root)),
        )
        .unwrap();

        assert_eq!(read(install.root.join("prism-server")), "new");
        assert_eq!(read(install.root.join("web").join("index.html")), "new");

        let trash_root = install.root.join(".update-trash");
        let batch = std::fs::read_dir(&trash_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        for entry in SWAP_ENTRIES {
            assert!(batch.join(entry).exists(), "{entry}");
        }
        assert_eq!(read(batch.join("prism")), "old");
    }

    #[test]
    fn moves_an_old_install_s_node_modules_into_the_trash() {
        let install = install();
        std::fs::create_dir_all(install.root.join("node_modules")).unwrap();
        std::fs::write(install.root.join("node_modules").join("dep.txt"), "old").unwrap();

        swap_install(
            &path_text(&install.dist_dir),
            Some(&path_text(&install.root)),
        )
        .unwrap();

        assert!(!install.root.join("node_modules").exists());
        let batch = std::fs::read_dir(install.root.join(".update-trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(read(batch.join("node_modules").join("dep.txt")), "old");
    }

    #[test]
    fn rolls_a_mid_swap_failure_back_to_the_original_install() {
        let install = install();
        // The last entry is missing from the staged dist, so the swap fails after
        // two entries already moved.
        std::fs::remove_file(install.dist_dir.join("prism-server")).unwrap();

        let error = swap_install(
            &path_text(&install.dist_dir),
            Some(&path_text(&install.root)),
        )
        .unwrap_err();
        assert_eq!(code_of(&error), Some(UpdateErrorCode::SwapFailed));

        // Every entry is back on the old content — no half-swapped install.
        for entry in ["prism", "prism-server"] {
            assert_eq!(read(install.root.join(entry)), "old");
        }
        assert_eq!(read(install.root.join("web").join("index.html")), "old");
    }

    #[test]
    fn removes_staging_and_trash_leftovers() {
        let install = install();
        std::fs::create_dir_all(install.root.join(".update-trash").join("123")).unwrap();
        sweep_update_dirs(Some(&path_text(&install.root)));
        assert!(!install.root.join("updates").exists());
        assert!(!install.root.join(".update-trash").exists());
    }

    #[test]
    fn removes_one_staged_release() {
        let install = install();
        remove_staged_release("v2026.8.24083158", Some(&path_text(&install.root)));
        assert!(!install.root.join("updates").join("v2026.8.24083158").exists());
        // A release that was never staged is fine.
        remove_staged_release("v2020.1.1000000", Some(&path_text(&install.root)));
    }

    #[tokio::test]
    async fn reports_a_stage_without_install_ps1_as_spawn_failed() {
        let install = install();
        let error = spawn_windows_installer(&path_text(&install.dist_dir), "v2026.8.24083158")
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), Some(UpdateErrorCode::SpawnFailed));
        assert_eq!(error.to_string(), "staged archive has no install.ps1");
    }

    // The staged binary is a real shell script the probe executes, so these run
    // only where a shebang runs (the same platforms the rename-swap serves).
    #[cfg(unix)]
    mod stage {
        use super::*;
        use axum::extract::State;
        use axum::http::{StatusCode, Uri};
        use axum::response::{IntoResponse, Response};
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        const VERSION: &str = "v2026.8.24083158";

        fn asset_name() -> String {
            format!("prism-{VERSION}-{}.tar.gz", os_arch())
        }

        /// A real release archive whose prism-server reports `reported_version`.
        fn build_archive(reported_version: &str) -> Vec<u8> {
            let fixture = tempfile::tempdir().unwrap();
            let dist = fixture.path().join(os_arch());
            std::fs::create_dir_all(dist.join("web")).unwrap();
            std::fs::write(dist.join("web").join("index.html"), "web").unwrap();
            std::fs::write(dist.join("prism"), "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::write(
                dist.join("prism-server"),
                format!("#!/bin/sh\necho {reported_version}\n"),
            )
            .unwrap();
            for binary in ["prism", "prism-server"] {
                std::fs::set_permissions(
                    dist.join(binary),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
            let archive = fixture.path().join(asset_name());
            let status = std::process::Command::new("tar")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(fixture.path())
                .arg(os_arch())
                .status()
                .unwrap();
            assert!(status.success());
            std::fs::read(archive).unwrap()
        }

        #[derive(Clone)]
        struct Release {
            archive: Option<Arc<Vec<u8>>>,
            checksum: Option<String>,
            requests: Arc<AtomicUsize>,
        }

        async fn serve_asset(State(release): State<Release>, uri: Uri) -> Response {
            release.requests.fetch_add(1, Ordering::SeqCst);
            if uri.path().ends_with(".sha256") {
                return match &release.checksum {
                    None => (StatusCode::NOT_FOUND, "not found").into_response(),
                    Some(sum) => format!("{sum}  {}\n", asset_name()).into_response(),
                };
            }
            match &release.archive {
                None => (StatusCode::NOT_FOUND, "not found").into_response(),
                Some(bytes) => bytes.as_ref().clone().into_response(),
            }
        }

        async fn releases(archive: Option<Vec<u8>>, checksum: Option<String>) -> (String, Release) {
            let release = Release {
                archive: archive.map(Arc::new),
                checksum,
                requests: Arc::default(),
            };
            let app = axum::Router::new()
                .fallback(serve_asset)
                .with_state(release.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (format!("http://{addr}"), release)
        }

        fn sha256_hex(bytes: &[u8]) -> String {
            hex::encode(Sha256::digest(bytes))
        }

        #[tokio::test]
        async fn downloads_verifies_and_stages_a_release_then_reuses_the_stage() {
            let install = install();
            let root = path_text(&install.root);
            let archive = build_archive(VERSION);
            let sum = sha256_hex(&archive);
            let (host, release) = releases(Some(archive), Some(sum)).await;

            let dist_dir = stage_release_from(&host, VERSION, &root).await.unwrap();
            assert_eq!(
                dist_dir,
                path_text(&install.root.join("updates").join(VERSION).join(os_arch()))
            );
            assert!(Path::new(&dist_dir).join("prism-server").exists());
            assert!(Path::new(&dist_dir).join("web").join("index.html").exists());
            assert!(
                !install
                    .root
                    .join("updates")
                    .join(VERSION)
                    .join(asset_name())
                    .exists()
            );

            // Second call (a deferred activation retrying): stage reused, no network.
            let before = release.requests.load(Ordering::SeqCst);
            assert_eq!(
                stage_release_from(&host, VERSION, &root).await.unwrap(),
                dist_dir
            );
            assert_eq!(release.requests.load(Ordering::SeqCst), before);
        }

        #[tokio::test]
        async fn records_a_missing_archive_as_asset_not_found() {
            let install = install();
            let archive = build_archive(VERSION);
            let sum = sha256_hex(&archive);
            let (host, _) = releases(None, Some(sum)).await;
            let error = stage_release_from(&host, VERSION, &path_text(&install.root))
                .await
                .unwrap_err();
            assert_eq!(code_of(&error), Some(UpdateErrorCode::AssetNotFound));
        }

        #[tokio::test]
        async fn fails_closed_when_no_checksum_is_published() {
            let install = install();
            let (host, _) = releases(Some(build_archive(VERSION)), None).await;
            let error = stage_release_from(&host, VERSION, &path_text(&install.root))
                .await
                .unwrap_err();
            // Its own code, not verify_failed: nothing said the bytes were wrong.
            assert_eq!(code_of(&error), Some(UpdateErrorCode::ChecksumUnavailable));
        }

        #[tokio::test]
        async fn fails_closed_on_a_checksum_mismatch() {
            let install = install();
            let (host, _) = releases(Some(build_archive(VERSION)), Some("a".repeat(64))).await;
            let error = stage_release_from(&host, VERSION, &path_text(&install.root))
                .await
                .unwrap_err();
            assert_eq!(code_of(&error), Some(UpdateErrorCode::VerifyFailed));
        }

        #[tokio::test]
        async fn rejects_an_archive_whose_binary_reports_the_wrong_version() {
            let install = install();
            let wrong = build_archive("v2020.1.1000000");
            let sum = sha256_hex(&wrong);
            let (host, _) = releases(Some(wrong), Some(sum)).await;
            let error = stage_release_from(&host, VERSION, &path_text(&install.root))
                .await
                .unwrap_err();
            assert_eq!(code_of(&error), Some(UpdateErrorCode::VerifyFailed));
            assert_eq!(
                error.to_string(),
                format!("staged prism-server reports v2020.1.1000000, expected {VERSION}")
            );
        }
    }
}
