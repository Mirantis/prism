//! Files for the local environment: the filesystem this process runs on.
//!
//! A failed call reads as Node's `fs` error does (`ENOENT: no such file or
//! directory, open '<path>'`), since tool results hand that text to the model,
//! and keeps the `std::io::ErrorKind` of the failure.

use std::io;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;

use crate::lib::execution_environments::execution_environment::{
    DirEntry, ExecutionFiles, FileStat,
};

pub struct LocalFiles;

#[async_trait]
impl ExecutionFiles for LocalFiles {
    async fn read_text(&self, path: &str, max_bytes: Option<usize>) -> anyhow::Result<String> {
        let Some(max_bytes) = max_bytes else {
            let bytes = read_file(path).await?;
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        };
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|err| node_fs_error(err, "open", Some(path), None))?;
        let mut buffer = Vec::with_capacity(max_bytes);
        file.take(max_bytes as u64)
            .read_to_end(&mut buffer)
            .await
            .map_err(|err| node_fs_error(err, "read", None, None))?;
        Ok(String::from_utf8_lossy(&buffer).into_owned())
    }

    async fn read_bytes(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        read_file(path).await
    }

    async fn write_text(&self, path: &str, content: &str, mode: Option<u32>) -> anyhow::Result<()> {
        write_file(path, content.as_bytes(), mode).await
    }

    async fn write_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        write_file(path, content, None).await
    }

    async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
        tokio::fs::create_dir_all(path)
            .await
            .map_err(|err| node_fs_error(err, "mkdir", Some(path), None))
    }

    /// `mkdtemp` under the OS temp dir, which creates the directory 0700.
    async fn make_temp_dir(&self, prefix: &str) -> anyhow::Result<String> {
        let prefix = prefix.to_string();
        tokio::task::spawn_blocking(move || {
            let template = std::env::temp_dir().join(format!("{prefix}XXXXXX"));
            tempfile::Builder::new()
                .prefix(&prefix)
                .rand_bytes(6)
                .tempdir()
                .map(|dir| dir.keep().to_string_lossy().into_owned())
                .map_err(|err| {
                    node_fs_error(err, "mkdtemp", Some(&template.to_string_lossy()), None)
                })
        })
        .await?
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        tokio::fs::rename(from, to)
            .await
            .map_err(|err| node_fs_error(err, "rename", Some(from), Some(to)))
    }

    async fn stat(&self, path: &str) -> anyhow::Result<FileStat> {
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|err| node_fs_error(err, "stat", Some(path), None))?;
        Ok(to_file_stat(&meta))
    }

    async fn lstat(&self, path: &str) -> anyhow::Result<FileStat> {
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .map_err(|err| node_fs_error(err, "lstat", Some(path), None))?;
        Ok(to_file_stat(&meta))
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
        let scandir = |err| node_fs_error(err, "scandir", Some(path), None);
        let mut dir = tokio::fs::read_dir(path).await.map_err(scandir)?;
        let mut entries = Vec::new();
        while let Some(entry) = dir.next_entry().await.map_err(scandir)? {
            let kind = entry.file_type().await.map_err(scandir)?;
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_file: kind.is_file(),
                is_directory: kind.is_dir(),
                is_symbolic_link: kind.is_symlink(),
            });
        }
        Ok(entries)
    }

    async fn remove(&self, path: &str) -> anyhow::Result<()> {
        let meta = match tokio::fs::symlink_metadata(path).await {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(node_fs_error(err, "lstat", Some(path), None)),
        };
        let removed = if meta.is_dir() {
            tokio::fs::remove_dir_all(path).await
        } else {
            tokio::fs::remove_file(path).await
        };
        match removed {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(node_fs_error(err, "rm", Some(path), None)),
        }
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        tokio::fs::remove_dir(path)
            .await
            .map_err(|err| node_fs_error(err, "rmdir", Some(path), None))
    }

    /// Replace an existing *link*, which may point somewhere stale, and refuse
    /// anything else: a real directory there holds somebody's files. `ln -sfn`
    /// draws the same line, so both environments answer alike.
    async fn symlink(&self, target: &str, link_path: &str) -> anyhow::Result<()> {
        // Nothing there is the ordinary case.
        if let Ok(meta) = tokio::fs::symlink_metadata(link_path).await
            && meta.file_type().is_symlink()
        {
            let _ = tokio::fs::remove_file(link_path).await;
        }
        create_symlink(target, link_path)
            .await
            .map_err(|err| node_fs_error(err, "symlink", Some(target), Some(link_path)))
    }

    async fn realpath(&self, path: &str) -> anyhow::Result<String> {
        let real = tokio::fs::canonicalize(path)
            .await
            .map_err(|err| node_fs_error(err, "realpath", Some(path), None))?;
        Ok(real.to_string_lossy().into_owned())
    }
}

/// `fs.readFile`: the open names the path, a failed read does not.
async fn read_file(path: &str) -> anyhow::Result<Vec<u8>> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| node_fs_error(err, "open", Some(path), None))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .await
        .map_err(|err| node_fs_error(err, "read", None, None))?;
    Ok(bytes)
}

/// `fs.writeFile`: create or truncate, with `mode` (0o666 by default, less the
/// umask) for a file this call creates.
async fn write_file(path: &str, content: &[u8], mode: Option<u32>) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(mode.unwrap_or(0o666));
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options
        .open(path)
        .await
        .map_err(|err| node_fs_error(err, "open", Some(path), None))?;
    file.write_all(content)
        .await
        .map_err(|err| node_fs_error(err, "write", None, None))?;
    file.flush()
        .await
        .map_err(|err| node_fs_error(err, "write", None, None))?;
    Ok(())
}

#[cfg(unix)]
async fn create_symlink(target: &str, link_path: &str) -> io::Result<()> {
    tokio::fs::symlink(target, link_path).await
}

/// Node picks a directory link when the target is a directory.
#[cfg(windows)]
async fn create_symlink(target: &str, link_path: &str) -> io::Result<()> {
    let is_dir = tokio::fs::metadata(target)
        .await
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    if is_dir {
        tokio::fs::symlink_dir(target, link_path).await
    } else {
        tokio::fs::symlink_file(target, link_path).await
    }
}

/// A `FileStat` from the metadata of a path, `mtime_ms` with Node's fraction.
pub fn to_file_stat(meta: &std::fs::Metadata) -> FileStat {
    FileStat {
        size: meta.len(),
        mtime_ms: mtime_ms(meta),
        is_file: meta.file_type().is_file(),
        is_directory: meta.file_type().is_dir(),
        is_symbolic_link: meta.file_type().is_symlink(),
    }
}

#[cfg(unix)]
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0
}

#[cfg(not(unix))]
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// A file error as Node words it: `<CODE>: <description>, <syscall> '<path>'`,
/// with ` -> '<dest>'` for a two-path call. The error keeps its kind.
pub fn node_fs_error(
    err: io::Error,
    syscall: &str,
    path: Option<&str>,
    dest: Option<&str>,
) -> anyhow::Error {
    let (code, description) = errno_text(&err);
    let mut message = format!("{code}: {description}, {syscall}");
    if let Some(path) = path {
        message.push_str(&format!(" '{path}'"));
    }
    if let Some(dest) = dest {
        message.push_str(&format!(" -> '{dest}'"));
    }
    anyhow::Error::new(io::Error::new(err.kind(), message))
}

/// libuv's name and description of an error, as Node prints them.
pub fn errno_text(err: &io::Error) -> (String, String) {
    #[cfg(unix)]
    if let Some(raw) = err.raw_os_error()
        && let Some((code, description)) = unix_errno_text(raw)
    {
        return (code.to_string(), description.to_string());
    }
    let (code, description) = match err.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        io::ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        io::ErrorKind::InvalidInput => ("EINVAL", "invalid argument"),
        io::ErrorKind::BrokenPipe => ("EPIPE", "broken pipe"),
        _ => return ("UNKNOWN".to_string(), err.to_string()),
    };
    (code.to_string(), description.to_string())
}

#[cfg(unix)]
fn unix_errno_text(raw: i32) -> Option<(&'static str, &'static str)> {
    let text = match raw {
        libc::E2BIG => ("E2BIG", "argument list too long"),
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        libc::EBADF => ("EBADF", "bad file descriptor"),
        libc::EBUSY => ("EBUSY", "resource busy or locked"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::EFAULT => ("EFAULT", "bad address in system call argument"),
        libc::EFBIG => ("EFBIG", "file too large"),
        libc::EINTR => ("EINTR", "interrupted system call"),
        libc::EINVAL => ("EINVAL", "invalid argument"),
        libc::EIO => ("EIO", "i/o error"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::EMLINK => ("EMLINK", "too many links"),
        libc::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        libc::ENFILE => ("ENFILE", "file table overflow"),
        libc::ENODEV => ("ENODEV", "no such device"),
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::ENOEXEC => ("ENOEXEC", "exec format error"),
        libc::ENOMEM => ("ENOMEM", "not enough memory"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::ENOSYS => ("ENOSYS", "function not implemented"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        libc::ENXIO => ("ENXIO", "no such device or address"),
        libc::EPERM => ("EPERM", "operation not permitted"),
        libc::EPIPE => ("EPIPE", "broken pipe"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::ESPIPE => ("ESPIPE", "invalid seek"),
        libc::ESRCH => ("ESRCH", "no such process"),
        libc::ETXTBSY => ("ETXTBSY", "text file is busy"),
        libc::EXDEV => ("EXDEV", "cross-device link not permitted"),
        _ => return None,
    };
    Some(text)
}

#[cfg(test)]
mod tests {
    //! The local files against a real temp directory, no mocks: what each file
    //! operation reports.

    use super::*;
    use crate::lib::execution_environments::execution_environment::io_error_kind;

    fn temp() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new().prefix("local-env-").tempdir().unwrap();
        // realpath, so macOS's /var → /private/var symlink doesn't make a path
        // comparison fail for reasons that have nothing to do with the test.
        let path = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, path)
    }

    #[tokio::test]
    async fn writes_and_reads_text() {
        let (_guard, dir) = temp();
        let file = format!("{dir}/a.txt");
        LocalFiles.write_text(&file, "hello", None).await.unwrap();
        assert_eq!(LocalFiles.read_text(&file, None).await.unwrap(), "hello");
    }

    #[tokio::test]
    async fn reads_only_the_requested_prefix() {
        let (_guard, dir) = temp();
        let file = format!("{dir}/head.txt");
        LocalFiles.write_text(&file, "abcdefghij", None).await.unwrap();
        assert_eq!(LocalFiles.read_text(&file, Some(4)).await.unwrap(), "abcd");
    }

    #[tokio::test]
    async fn writes_and_reads_bytes() {
        let (_guard, dir) = temp();
        let file = format!("{dir}/a.bin");
        LocalFiles.write_bytes(&file, &[0, 1, 2, 255]).await.unwrap();
        assert_eq!(LocalFiles.read_bytes(&file).await.unwrap(), vec![0, 1, 2, 255]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn creates_a_file_with_the_requested_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (_guard, dir) = temp();
        let file = format!("{dir}/mcp.json");
        LocalFiles.write_text(&file, "{}", Some(0o600)).await.unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[tokio::test]
    async fn creates_parent_directories() {
        let (_guard, dir) = temp();
        let nested = format!("{dir}/x/y");
        LocalFiles.mkdir(&nested).await.unwrap();
        assert!(LocalFiles.stat(&nested).await.unwrap().is_directory);
    }

    #[tokio::test]
    async fn renames_a_file() {
        let (_guard, dir) = temp();
        let from = format!("{dir}/from");
        let to = format!("{dir}/to");
        LocalFiles.write_text(&from, "moved", None).await.unwrap();
        LocalFiles.rename(&from, &to).await.unwrap();
        assert_eq!(LocalFiles.read_text(&to, None).await.unwrap(), "moved");
        assert!(LocalFiles.stat(&from).await.is_err());
    }

    #[tokio::test]
    async fn reports_size_kind_and_modification_time() {
        let (_guard, dir) = temp();
        let file = format!("{dir}/stat.txt");
        LocalFiles.write_text(&file, "abc", None).await.unwrap();
        let stat = LocalFiles.stat(&file).await.unwrap();
        assert_eq!(stat.size, 3);
        assert!(stat.is_file);
        assert!(!stat.is_directory);
        assert!(stat.mtime_ms > 0.0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn follows_a_symlink_on_stat_and_reports_it_on_lstat() {
        let (_guard, dir) = temp();
        let target = format!("{dir}/target");
        let link = format!("{dir}/link");
        LocalFiles.write_text(&target, "x", None).await.unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(!LocalFiles.stat(&link).await.unwrap().is_symbolic_link);
        assert!(LocalFiles.lstat(&link).await.unwrap().is_symbolic_link);
    }

    #[tokio::test]
    async fn lists_a_directory_with_the_kind_of_each_entry() {
        let (_guard, dir) = temp();
        LocalFiles.mkdir(&format!("{dir}/sub")).await.unwrap();
        LocalFiles.write_text(&format!("{dir}/file"), "x", None).await.unwrap();
        let mut entries = LocalFiles.read_dir(&dir).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            entries,
            vec![
                DirEntry {
                    name: "file".into(),
                    is_file: true,
                    is_directory: false,
                    is_symbolic_link: false
                },
                DirEntry {
                    name: "sub".into(),
                    is_file: false,
                    is_directory: true,
                    is_symbolic_link: false
                },
            ]
        );
    }

    #[tokio::test]
    async fn removes_a_tree_and_a_path_that_is_already_gone() {
        let (_guard, dir) = temp();
        let tree = format!("{dir}/tree/deep");
        LocalFiles.mkdir(&tree).await.unwrap();
        LocalFiles.write_text(&format!("{tree}/f"), "x", None).await.unwrap();
        LocalFiles.remove(&format!("{dir}/tree")).await.unwrap();
        assert!(LocalFiles.stat(&format!("{dir}/tree")).await.is_err());
        assert!(LocalFiles.remove(&format!("{dir}/tree")).await.is_ok());
    }

    #[tokio::test]
    async fn removes_an_empty_directory_and_refuses_a_populated_one() {
        let (_guard, dir) = temp();
        let empty = format!("{dir}/empty");
        let full = format!("{dir}/full");
        LocalFiles.mkdir(&empty).await.unwrap();
        LocalFiles.mkdir(&full).await.unwrap();
        LocalFiles.write_text(&format!("{full}/f"), "x", None).await.unwrap();
        assert!(LocalFiles.remove_dir(&empty).await.is_ok());
        assert!(LocalFiles.remove_dir(&full).await.is_err());
    }

    #[tokio::test]
    async fn fails_on_a_file_that_is_not_there_as_node_words_it() {
        let (_guard, dir) = temp();
        let missing = format!("{dir}/nope");
        let err = LocalFiles.read_text(&missing, None).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("ENOENT: no such file or directory, open '{missing}'")
        );
        assert_eq!(io_error_kind(&err), Some(io::ErrorKind::NotFound));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replaces_a_link_and_refuses_anything_else() {
        let (_guard, dir) = temp();
        let link = format!("{dir}/link");
        LocalFiles.symlink("/one", &link).await.unwrap();
        LocalFiles.symlink("/two", &link).await.unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap().to_string_lossy(), "/two");

        let real = format!("{dir}/real");
        LocalFiles.mkdir(&real).await.unwrap();
        assert!(LocalFiles.symlink("/three", &real).await.is_err());
    }

    #[tokio::test]
    async fn makes_a_temp_dir_with_the_prefix() {
        let made = LocalFiles.make_temp_dir("prism-local-files-").await.unwrap();
        let name = std::path::Path::new(&made)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("prism-local-files-"));
        assert_eq!(name.len(), "prism-local-files-".len() + 6);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&made).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        std::fs::remove_dir(&made).unwrap();
    }
}
