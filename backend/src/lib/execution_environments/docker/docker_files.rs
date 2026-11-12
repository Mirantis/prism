//! The container's filesystem, reached from the host.
//!
//! The agent's files live in named volumes, so this process cannot open them
//! and every operation is one `docker exec`. That is a process launch per call,
//! which is affordable because none of these paths is hot: the skill and plugin
//! catalogs are cached on a directory's mtime, an oversized tool result is one
//! write, and an attachment is a handful of calls. A resident helper speaking a
//! protocol would be faster and is not worth its lifecycle yet.
//!
//! A path is always a positional argument, never text inside the script, so a
//! name holding a quote or a space cannot become part of the command. Output is
//! collected as bytes and decoded only where the contract asks for text.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::container_lost::report_if_container_lost;
use super::docker_process::host_cwd;
use super::engine::DOCKER;
use crate::lib::execution_environments::execution_environment::{
    DirEntry, ExecOutput, ExecutionFiles, FileStat, RunOptions, Signal, StdinMode, io_error_kind,
};
use crate::lib::execution_environments::local::local_env::process_env;
use crate::lib::execution_environments::local::local_process::run_local_program;
use crate::log_warn;
use crate::support::js;

/// Long enough for a large file over the engine's pipe, short enough to give up.
pub const FILE_TIMEOUT_MS: u64 = 60_000;

/// `stat -c` in one line: size, mtime in seconds, and the kind.
pub const STAT_FORMAT: &str = "%s %Y %F";

/// One call for names and kinds together. `%y` is the entry's own type, so a
/// symlink reads as a symlink, and `\0` keeps a name with a newline in it whole.
const READ_DIR_SCRIPT: &str = r#"find -H "$1" -mindepth 1 -maxdepth 1 -printf '%y %f\0'"#;

pub struct DockerFiles {
    container: String,
}

pub fn create_docker_files(container: &str) -> Arc<dyn ExecutionFiles> {
    Arc::new(DockerFiles {
        container: container.to_string(),
    })
}

/// `"$1"`, `"$2"`: a positional argument, quoted for the shell.
fn arg(n: u8) -> String {
    format!("\"${n}\"")
}

impl DockerFiles {
    /// One `sh -c <script> prism-files <args…>` in the container; see `exec_in_container`.
    async fn run(
        &self,
        script: &str,
        args: &[String],
        stdin: Option<&[u8]>,
    ) -> anyhow::Result<Vec<u8>> {
        exec_in_container(&self.container, script, args, stdin).await
    }
}

#[async_trait]
impl ExecutionFiles for DockerFiles {
    /// `cat -- "$1"`, or `head -c "$2" -- "$1"` for a prefix: the cut happens in
    /// the container, so a large file never crosses the pipe.
    async fn read_text(&self, path: &str, max_bytes: Option<usize>) -> anyhow::Result<String> {
        let out = match max_bytes {
            None => self.run(&cat_script(), &[path.to_string()], None).await?,
            Some(max) => {
                let script = format!("head -c {} -- {}", arg(2), arg(1));
                self.run(&script, &[path.to_string(), max.to_string()], None)
                    .await?
            }
        };
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    async fn read_bytes(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        self.run(&cat_script(), &[path.to_string()], None).await
    }

    async fn write_text(&self, path: &str, content: &str, mode: Option<u32>) -> anyhow::Result<()> {
        write_file(&self.container, path, content.as_bytes(), mode).await
    }

    async fn write_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        write_file(&self.container, path, content, None).await
    }

    async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
        let script = format!("mkdir -p -- {}", arg(1));
        self.run(&script, &[path.to_string()], None).await?;
        Ok(())
    }

    /// `mktemp -d "${TMPDIR:-/tmp}/${1}XXXXXXXX"`, which creates the directory 0700.
    async fn make_temp_dir(&self, prefix: &str) -> anyhow::Result<String> {
        let out = self
            .run(MAKE_TEMP_DIR_SCRIPT, &[prefix.to_string()], None)
            .await?;
        Ok(js::trim(&String::from_utf8_lossy(&out)).to_string())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        let script = format!("mv -f -- {} {}", arg(1), arg(2));
        self.run(&script, &[from.to_string(), to.to_string()], None)
            .await?;
        Ok(())
    }

    /// `-L` follows the link and reports the target, which is what `stat` means
    /// here; `lstat` reports the link itself.
    async fn stat(&self, path: &str) -> anyhow::Result<FileStat> {
        let script = format!("stat -L -c '{STAT_FORMAT}' -- {}", arg(1));
        parse_stat(&self.run(&script, &[path.to_string()], None).await?)
    }

    async fn lstat(&self, path: &str) -> anyhow::Result<FileStat> {
        let script = format!("stat -c '{STAT_FORMAT}' -- {}", arg(1));
        parse_stat(&self.run(&script, &[path.to_string()], None).await?)
    }

    /// One call for names and kinds together. `%y` is the entry's own type, so
    /// a symlink reads as a symlink, and `\0` keeps a name with a newline in it
    /// whole: `find -H "$1" -mindepth 1 -maxdepth 1 -printf '%y %f\0'`.
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
        let out = self.run(READ_DIR_SCRIPT, &[path.to_string()], None).await?;
        Ok(parse_dir_entries(&out))
    }

    async fn remove(&self, path: &str) -> anyhow::Result<()> {
        let script = format!("rm -rf -- {}", arg(1));
        self.run(&script, &[path.to_string()], None).await?;
        Ok(())
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        let script = format!("rmdir -- {}", arg(1));
        self.run(&script, &[path.to_string()], None).await?;
        Ok(())
    }

    /// `ln -sfn`: `-f` replaces an existing link and `-n` stops `ln` following
    /// one that already points at a directory, which would nest the new link
    /// inside it.
    async fn symlink(&self, target: &str, link_path: &str) -> anyhow::Result<()> {
        let script = format!("ln -sfn -- {} {}", arg(1), arg(2));
        self.run(&script, &[target.to_string(), link_path.to_string()], None)
            .await?;
        Ok(())
    }

    /// `readlink -e`, which fails when the path does not exist, as `realpath(3)`
    /// does and as the local implementation reports.
    async fn realpath(&self, path: &str) -> anyhow::Result<String> {
        let script = format!("readlink -e -- {}", arg(1));
        let out = self.run(&script, &[path.to_string()], None).await?;
        Ok(js::trim(&String::from_utf8_lossy(&out)).to_string())
    }
}

/// `cat -- "$1"`.
fn cat_script() -> String {
    format!("cat -- {}", arg(1))
}

/// `mktemp -d "${TMPDIR:-/tmp}/${1}XXXXXXXX"`.
const MAKE_TEMP_DIR_SCRIPT: &str = r#"mktemp -d "${TMPDIR:-/tmp}/${1}XXXXXXXX""#;

/// `cat > "$1"` with the content on stdin; with a `mode`,
/// `umask "$2" && cat > "$1"`, since `cat` creates the file 0666 less the umask.
async fn write_file(
    container: &str,
    path: &str,
    content: &[u8],
    mode: Option<u32>,
) -> anyhow::Result<()> {
    let Some(mode) = mode else {
        let script = format!("cat > {}", arg(1));
        exec_in_container(container, &script, &[path.to_string()], Some(content)).await?;
        return Ok(());
    };
    let script = format!("umask {} && cat > {}", arg(2), arg(1));
    let umask = format!("{:o}", 0o666 & !mode);
    exec_in_container(
        container,
        &script,
        &[path.to_string(), umask],
        Some(content),
    )
    .await?;
    Ok(())
}

/// `docker exec [-i] <container> sh -c <script> prism-files <args…>`: `$0` for
/// the shell itself, so the caller's arguments start at `$1`.
pub fn file_argv(container: &str, script: &str, args: &[String], with_stdin: bool) -> Vec<String> {
    let mut argv = vec!["exec".to_string()];
    if with_stdin {
        argv.push("-i".to_string());
    }
    argv.extend([container, "sh", "-c", script, "prism-files"].map(str::to_string));
    argv.extend(args.iter().cloned());
    argv
}

/// One command in the container, with its output collected.
///
/// Fails on a non-zero exit, carrying the engine's own words and — when the
/// shell reported a missing path — the `NotFound` kind, since a caller that
/// branches on a missing file reads the error kind and the local implementation
/// gives it one.
async fn exec_in_container(
    container: &str,
    script: &str,
    args: &[String],
    stdin: Option<&[u8]>,
) -> anyhow::Result<Vec<u8>> {
    let argv = file_argv(container, script, args, stdin.is_some());
    let proc = run_local_program(
        DOCKER,
        &argv,
        RunOptions {
            cwd: host_cwd(),
            env: process_env(),
            stdin: if stdin.is_some() {
                StdinMode::Pipe
            } else {
                StdinMode::Ignore
            },
        },
        false,
    );

    let out = read_all(proc.take_stdout());
    let err = read_all(proc.take_stderr());
    if let Some(content) = stdin
        && let Some(mut writer) = proc.take_stdin()
    {
        let content = content.to_vec();
        tokio::spawn(async move {
            let _ = writer.write_all(&content).await;
            let _ = writer.shutdown().await;
        });
    }

    let end = tokio::select! {
        end = proc.closed() => end,
        _ = tokio::time::sleep(Duration::from_millis(FILE_TIMEOUT_MS)) => {
            proc.kill(Signal::SIGKILL);
            proc.closed().await
        }
    };
    let out = out.await.unwrap_or_default();
    let err = err.await.unwrap_or_default();

    if let Some(error) = end.error {
        let kind = io_error_kind(&error).unwrap_or(std::io::ErrorKind::Other);
        return Err(anyhow::Error::new(std::io::Error::new(
            kind,
            error.to_string(),
        )));
    }
    if end.exit_code != Some(0) {
        let said = js::trim(&String::from_utf8_lossy(&err)).to_string();
        report_if_container_lost(container, &said);
        let path = args.first().map(String::as_str).unwrap_or_default();
        return Err(file_error(&said, end.exit_code, path));
    }
    Ok(out)
}

/// Read a stream to its end.
fn read_all(stream: Option<ExecOutput>) -> tokio::task::JoinHandle<Vec<u8>> {
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut bytes).await;
        }
        bytes
    })
}

/// The error for a failed file command: the engine's words (or
/// `the container exited <code> for <path>`), as a `std::io::Error` of kind
/// `NotFound` (ENOENT), `NotADirectory` (ENOTDIR), `PermissionDenied` (EACCES)
/// or `DirectoryNotEmpty` (ENOTEMPTY) when the words name one, else `Other`.
fn file_error(said: &str, exit_code: Option<i32>, path: &str) -> anyhow::Error {
    let message = if said.is_empty() {
        let code = exit_code.map_or_else(|| "null".to_string(), |code| code.to_string());
        format!("the container exited {code} for {path}")
    } else {
        said.to_string()
    };
    let kind = if NO_SUCH_FILE.is_match(said) {
        std::io::ErrorKind::NotFound
    } else if NOT_A_DIRECTORY.is_match(said) {
        std::io::ErrorKind::NotADirectory
    } else if PERMISSION_DENIED.is_match(said) {
        std::io::ErrorKind::PermissionDenied
    } else if NOT_EMPTY.is_match(said) {
        std::io::ErrorKind::DirectoryNotEmpty
    } else {
        std::io::ErrorKind::Other
    };
    anyhow::Error::new(std::io::Error::new(kind, message))
}

static NO_SUCH_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)No such file or directory").unwrap());
static NOT_A_DIRECTORY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Not a directory").unwrap());
static PERMISSION_DENIED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Permission denied").unwrap());
static NOT_EMPTY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Directory not empty").unwrap());

static STAT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+) (\d+) (.+)$").unwrap());

/// `<size> <mtime seconds> <kind words>` from one `stat -c` line.
pub fn parse_stat(out: &[u8]) -> anyhow::Result<FileStat> {
    let text = String::from_utf8_lossy(out);
    let line = js::trim(&text);
    let Some(caps) = STAT_LINE.captures(line) else {
        anyhow::bail!("could not read a file's details: {line}");
    };
    let kind = &caps[3];
    let mtime_seconds: f64 = caps[2].parse().unwrap_or(0.0);
    Ok(FileStat {
        size: caps[1].parse().unwrap_or(0),
        mtime_ms: mtime_seconds * 1000.0,
        // `stat` spells these out: "regular file", "regular empty file",
        // "directory", "symbolic link".
        is_file: kind.contains("file"),
        is_directory: kind == "directory",
        is_symbolic_link: kind == "symbolic link",
    })
}

/// `<type letter> <name>` records, each ended by a NUL.
pub fn parse_dir_entries(out: &[u8]) -> Vec<DirEntry> {
    let text = String::from_utf8_lossy(out);
    let mut entries = Vec::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut chars = record.chars();
        let kind = chars.next();
        chars.next();
        let name = chars.as_str();
        if name.is_empty() {
            log_warn!(
                serde_json::json!({ "record": record }),
                "[Docker] skipped a directory entry with no name"
            );
            continue;
        }
        entries.push(DirEntry {
            name: name.to_string(),
            is_file: kind == Some('f'),
            is_directory: kind == Some('d'),
            is_symbolic_link: kind == Some('l'),
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    //! The filesystem calls sent to the engine, and how their output is read
    //! back. The engine is never run; the scripts run in a real shell here as
    //! the container would run them.

    use super::*;

    fn sh(script: &str, args: &[String], input: Option<&[u8]>, tmpdir: Option<&str>) -> Vec<u8> {
        use std::io::Write;
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", script, "prism-files"]).args(args);
        if let Some(dir) = tmpdir {
            cmd.env("TMPDIR", dir);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        if let Some(input) = input {
            stdin.write_all(input).unwrap();
        }
        drop(stdin);
        child.wait_with_output().unwrap().stdout
    }

    #[test]
    fn reads_a_whole_file_with_the_path_as_an_argument() {
        // The path is an argument, never text in the script, so a name holding a
        // quote or a space cannot become part of the command.
        let argv = file_argv(
            "agent-exec-test",
            &cat_script(),
            &["/prism/workspace/a.txt".to_string()],
            false,
        );
        assert_eq!(
            argv,
            [
                "exec",
                "agent-exec-test",
                "sh",
                "-c",
                "cat -- \"$1\"",
                "prism-files",
                "/prism/workspace/a.txt"
            ]
        );
    }

    #[test]
    fn sends_written_content_on_stdin() {
        // `-i` is what connects our stdin to the container's.
        let argv = file_argv(
            "c",
            "cat > \"$1\"",
            &["/prism/workspace/a.txt".into()],
            true,
        );
        assert_eq!(&argv[..3], &["exec", "-i", "c"]);
    }

    #[test]
    fn spells_each_script_as_the_container_runs_it() {
        assert_eq!(
            MAKE_TEMP_DIR_SCRIPT,
            "mktemp -d \"${TMPDIR:-/tmp}/${1}XXXXXXXX\""
        );
        assert_eq!(
            READ_DIR_SCRIPT,
            "find -H \"$1\" -mindepth 1 -maxdepth 1 -printf '%y %f\\0'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn creates_a_file_with_the_requested_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("mcp.json").to_string_lossy().into_owned();
        let script = format!("umask {} && cat > {}", arg(2), arg(1));
        let umask = format!("{:o}", 0o666 & !0o600u32);
        sh(&script, &[file.clone(), umask], Some(b"{\"a\":1}"), None);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"a\":1}");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn makes_a_new_directory_only_its_user_can_open() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let tmp_path = tmp.path().to_string_lossy().into_owned();
        let out = sh(
            MAKE_TEMP_DIR_SCRIPT,
            &["prism-claude-code-".to_string()],
            None,
            Some(&tmp_path),
        );
        let dir = js::trim(&String::from_utf8_lossy(&out)).to_string();
        let path = std::path::Path::new(&dir);
        assert_eq!(path.parent().unwrap(), tmp.path());
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("prism-claude-code-")
        );
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn reports_a_missing_path_the_way_the_local_filesystem_does() {
        let err = file_error(
            "cat: /prism/workspace/nope: No such file or directory",
            Some(1),
            "/prism/workspace/nope",
        );
        assert_eq!(
            crate::lib::execution_environments::execution_environment::io_error_kind(&err),
            Some(std::io::ErrorKind::NotFound)
        );
    }

    #[test]
    fn carries_the_engines_own_words_for_anything_else() {
        let err = file_error(
            "rmdir: failed to remove: Directory not empty",
            Some(1),
            "/prism/workspace/full",
        );
        assert_eq!(
            err.to_string(),
            "rmdir: failed to remove: Directory not empty"
        );
        assert_eq!(
            crate::lib::execution_environments::execution_environment::io_error_kind(&err),
            Some(std::io::ErrorKind::DirectoryNotEmpty)
        );
        let silent = file_error("", Some(2), "/prism/x");
        assert_eq!(silent.to_string(), "the container exited 2 for /prism/x");
    }

    #[test]
    fn reads_one_stat_line() {
        assert_eq!(
            parse_stat(b"4096 1758470400 directory\n").unwrap(),
            FileStat {
                size: 4096,
                mtime_ms: 1_758_470_400_000.0,
                is_file: false,
                is_directory: true,
                is_symbolic_link: false,
            }
        );
        let file = parse_stat(b"12 1758470400 regular file").unwrap();
        assert!(file.is_file && !file.is_directory);
        // `stat` spells an empty file out differently, and it is still a file.
        assert!(parse_stat(b"0 1 regular empty file").unwrap().is_file);
        let link = parse_stat(b"7 1 symbolic link").unwrap();
        assert!(link.is_symbolic_link && !link.is_file);
    }

    #[test]
    fn reads_a_directory_listing_including_a_name_with_a_newline_in_it() {
        let entries = parse_dir_entries(b"f a.txt\0d nested\0l link\0f odd\nname\0");
        let entry = |name: &str, f: bool, d: bool, l: bool| DirEntry {
            name: name.to_string(),
            is_file: f,
            is_directory: d,
            is_symbolic_link: l,
        };
        assert_eq!(
            entries,
            vec![
                entry("a.txt", true, false, false),
                entry("nested", false, true, false),
                entry("link", false, false, true),
                entry("odd\nname", true, false, false),
            ]
        );
    }

    #[test]
    fn reads_an_empty_directory_as_empty() {
        assert!(parse_dir_entries(b"").is_empty());
    }
}
