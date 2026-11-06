//! Files for the local environment: the filesystem this process runs on.

use async_trait::async_trait;

use crate::lib::execution_environments::execution_environment::{
    DirEntry, ExecutionFiles, FileStat,
};

pub struct LocalFiles;

#[async_trait]
impl ExecutionFiles for LocalFiles {
    async fn read_text(&self, path: &str, max_bytes: Option<usize>) -> anyhow::Result<String> {
        todo!()
    }

    async fn read_bytes(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        todo!()
    }

    async fn write_text(&self, path: &str, content: &str, mode: Option<u32>) -> anyhow::Result<()> {
        todo!()
    }

    async fn write_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        todo!()
    }

    async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// `mkdtemp` under the OS temp dir, which creates the directory 0700.
    async fn make_temp_dir(&self, prefix: &str) -> anyhow::Result<String> {
        todo!()
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        todo!()
    }

    async fn stat(&self, path: &str) -> anyhow::Result<FileStat> {
        todo!()
    }

    async fn lstat(&self, path: &str) -> anyhow::Result<FileStat> {
        todo!()
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
        todo!()
    }

    async fn remove(&self, path: &str) -> anyhow::Result<()> {
        todo!()
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Replace an existing *link*, which may point somewhere stale, and refuse
    /// anything else: a real directory there holds somebody's files. `ln -sfn`
    /// draws the same line, so both environments answer alike.
    async fn symlink(&self, target: &str, link_path: &str) -> anyhow::Result<()> {
        todo!()
    }

    async fn realpath(&self, path: &str) -> anyhow::Result<String> {
        todo!()
    }
}

/// A `FileStat` from the metadata of a path, `mtime_ms` with Node's fraction.
pub fn to_file_stat(meta: &std::fs::Metadata) -> FileStat {
    use std::os::unix::fs::MetadataExt;
    FileStat {
        size: meta.len(),
        mtime_ms: meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0,
        is_file: meta.file_type().is_file(),
        is_directory: meta.file_type().is_dir(),
        is_symbolic_link: meta.file_type().is_symlink(),
    }
}
