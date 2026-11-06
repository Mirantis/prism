//! Resolve the on-disk path for the SQLite database, so every connection the
//! runtime opens (the pool, the sqlite-vec bootstrap, backup/restore) reads and
//! writes the same file.
//!
//! Relative paths in `DATABASE_URL=file:...` resolve against the **directory
//! containing the schema file**, not the process cwd: `file:./agent-local.db`
//! is `<repo>/prisma/sqlite/agent-local.db`. `prisma.config.ts` applies the same
//! rule for the Prisma CLI, so migrations land in that file too.
//!
//! Absolute paths (the production `file:/data/agent.db` shape) pass through
//! unchanged.

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use anyhow::bail;

/// `<repo>/prisma/sqlite`, the schema's directory in the checkout this binary was
/// built from.
pub static SCHEMA_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    normalize(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("prisma")
            .join("sqlite"),
    )
});

pub fn resolve_prisma_sqlite_path(database_url: Option<&str>) -> anyhow::Result<String> {
    let Some(database_url) = database_url.filter(|url| !url.is_empty()) else {
        bail!("DATABASE_URL is required");
    };
    let raw = database_url.strip_prefix("file:").unwrap_or(database_url);
    // SQLite's in-memory tokens (`:memory:`, named shared-cache `file::memory:?cache=…`)
    // must pass through unchanged — they aren't filesystem paths.
    if raw == ":memory:" || raw.starts_with(':') {
        return Ok(raw.to_string());
    }
    if Path::new(raw).is_absolute() {
        return Ok(raw.to_string());
    }
    Ok(normalize(&SCHEMA_DIR.join(raw))
        .to_string_lossy()
        .into_owned())
}

/// `path.resolve` without the working directory: `.` and `..` segments removed and
/// a trailing separator dropped, without reading the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_database_url() {
        assert_eq!(
            resolve_prisma_sqlite_path(None).unwrap_err().to_string(),
            "DATABASE_URL is required"
        );
        assert_eq!(
            resolve_prisma_sqlite_path(Some(""))
                .unwrap_err()
                .to_string(),
            "DATABASE_URL is required"
        );
    }

    #[test]
    fn passes_an_absolute_path_through() {
        assert_eq!(
            resolve_prisma_sqlite_path(Some("file:/data/agent.db")).unwrap(),
            "/data/agent.db"
        );
        assert_eq!(
            resolve_prisma_sqlite_path(Some("/data/agent.db")).unwrap(),
            "/data/agent.db"
        );
    }

    #[test]
    fn passes_in_memory_tokens_through() {
        assert_eq!(
            resolve_prisma_sqlite_path(Some("file::memory:")).unwrap(),
            ":memory:"
        );
        assert_eq!(
            resolve_prisma_sqlite_path(Some(":memory:")).unwrap(),
            ":memory:"
        );
        assert_eq!(
            resolve_prisma_sqlite_path(Some("file::memory:?cache=shared")).unwrap(),
            ":memory:?cache=shared"
        );
    }

    #[test]
    fn resolves_a_relative_path_against_the_schema_directory() {
        let expected = SCHEMA_DIR.join("agent-local.db");
        assert_eq!(
            resolve_prisma_sqlite_path(Some("file:./agent-local.db")).unwrap(),
            expected.to_string_lossy()
        );
        let parent = SCHEMA_DIR.parent().unwrap().join("other.db");
        assert_eq!(
            resolve_prisma_sqlite_path(Some("file:../other.db")).unwrap(),
            parent.to_string_lossy()
        );
        assert!(SCHEMA_DIR.ends_with("prisma/sqlite"));
        assert!(SCHEMA_DIR.join("schema.prisma").exists());
    }
}
