//! Hourly janitor for the two durable stores that hold content a conversation
//! refers to but does not itself contain.
//!
//! Attachments: abandoned pre-send uploads (chip added but never sent), stale
//! hydrate scratch dirs, content past its TTL, and stray media files no row
//! references (cascade-deleted messages, imports).
//!
//! Saved tool outputs: everything past its TTL. Nothing references one, so there is
//! no live set to reconcile and no orphan case — mtime against the TTL is the whole
//! of it. Deleting a thread removes its saved outputs eagerly; this is the backstop
//! for what that misses.
//!
//! Every sweep step catches its own failure — one broken step must not stop the
//! others, and the next hour retries it.

use tokio::task::JoinHandle;

const SWEEP_INTERVAL_MS: u64 = 60 * 60 * 1000;
const ORPHAN_TTL_MS: i64 = 24 * 60 * 60 * 1000;
// Grace before a stray media file may be reaped — covers the window between
// the file write and its row insert. Never shorten below 1 h.
const STRAY_MEDIA_GRACE_MS: i64 = 60 * 60 * 1000;

/// One full sweep. Never fails.
///
/// In order, each step logging its own failure and its non-zero count:
/// 1. orphaned uploads older than a day, sparing the attachments a reply a
///    restart interrupted still owes (`attachments_held_by_chat_work`);
/// 2. stale scratch dirs under the default workspace and under every distinct
///    thread `workspaceRoot` (a TUI thread's launch cwd);
/// 3. attachment content past `config.attachment_content_ttl_ms`;
/// 4. stray media files, with a one-hour grace;
/// 5. saved tool outputs past `config.tool_output_ttl_ms`.
pub async fn sweep_files() {
    todo!()
}

/// Sweep once now, then every hour. Returns the task so the caller can abort
/// it on shutdown; it never holds the process open.
pub async fn start_file_janitor() -> JoinHandle<()> {
    todo!()
}
