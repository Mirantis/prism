//! Read a file the agent wrote, for delivery to the user: one regular, non-empty
//! file within the attachment size cap, and the same bytes from start to end of
//! the read.

use crate::constants::{MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB};
use crate::lib::execution_environments::execution_environment::FileStat;
use crate::lib::execution_environments::get_execution_environment::files_for;

/// Whether the file changed across a read: either it no longer matches the bytes
/// just read, or its mtime has moved on from the stat taken before that read.
/// Both halves matter — an edit that keeps the length is still a different file.
fn moved(before: &FileStat, after: &FileStat, data: &[u8]) -> bool {
    after.size != data.len() as u64 || after.mtime_ms != before.mtime_ms
}

/// `(bytes / MiB).toFixed(1)`: the exact value rounded half up to one decimal,
/// as `Number.prototype.toFixed` rounds, where Rust rounds a tie to even.
fn megabytes(bytes: u64) -> String {
    // Tenths of a MiB, rounded half up: exact in integers.
    let tenths = (bytes * 10 + 1024 * 1024 / 2) / (1024 * 1024);
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// The refusal for a file over the cap.
fn too_large(bytes: u64) -> String {
    format!(
        "File too large ({} MB) — max {MAX_FILE_SIZE_MB} MB.",
        megabytes(bytes)
    )
}

/// The file's bytes, read through the filesystem that holds `full_path`, or the
/// error the agent reads. `shown_path` is the path as the agent wrote it.
pub async fn read_settled_file(full_path: &str, shown_path: &str) -> Result<Vec<u8>, String> {
    let files = files_for(full_path);
    let Ok(stat) = files.stat(full_path).await else {
        return Err(format!("File not found: {shown_path}"));
    };
    if stat.is_directory {
        return Err(format!(
            "{shown_path} is a directory — share a single file."
        ));
    }
    if stat.size == 0 {
        return Err(format!("File is empty: {shown_path}"));
    }
    if stat.size > MAX_FILE_SIZE_BYTES as u64 {
        return Err(too_large(stat.size));
    }

    // Read, then confirm the file did not move under the read. This catches the
    // writers that outlive their call (`coding_agent`, `shell_spawn`) in the one
    // window where they are observable at all. One retry: a second change means
    // something is still writing, and guessing which revision the reply describes
    // is exactly the mistake being fixed.
    let read = async {
        let mut before = stat;
        let mut data = files.read_bytes(full_path).await?;
        let mut after = files.stat(full_path).await?;
        if moved(&before, &after, &data) {
            before = after;
            data = files.read_bytes(full_path).await?;
            after = files.stat(full_path).await?;
            // Compare against the stat taken just before the retry, and on mtime as
            // well as size — a same-size edit is still a different revision, and size
            // alone would let one through.
            if moved(&before, &after, &data) {
                return Ok(None);
            }
        }
        anyhow::Ok(Some(data))
    };
    let data = match read.await {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Err(format!(
                "Not shared: {shown_path} is changing while it is read, so the attachment would not match what you describe. Wait for the write to finish, then share it."
            ));
        }
        Err(err) => return Err(err.to_string()),
    };

    // Re-check the guards against the bytes actually read. The stat above can be
    // stale by now — a background writer may have grown the file past the cap or
    // truncated it to nothing — and `data` is what goes into the media store.
    if data.is_empty() {
        return Err(format!("File is empty: {shown_path}"));
    }
    if data.len() as u64 > MAX_FILE_SIZE_BYTES as u64 {
        return Err(too_large(data.len() as u64));
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_megabytes_as_to_fixed_does() {
        assert_eq!(megabytes(10 * 1024 * 1024 + 1), "10.0");
        // 10.25 MiB is a tie, which toFixed rounds up.
        assert_eq!(megabytes(10_747_904), "10.3");
        assert_eq!(megabytes(11 * 1024 * 1024), "11.0");
    }
}
