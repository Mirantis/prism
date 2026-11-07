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

use std::time::Duration;

use diesel::prelude::*;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::config::CONFIG;
use crate::db::schema::conversation_threads::dsl as t;
use crate::lib::log_redaction::err_json;
use crate::lib::media_store::reap_stray_media_files;
use crate::lib::tool_output_store::reap_expired_tool_outputs;
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::conversation_engine_service::attachments_held_by_chat_work;
use crate::tools::attachments::reap_scratch_dirs;
use crate::{log_error, log_info};

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
    let orphans = async {
        // A reply a restart interrupted still owes its files, however long the runtime was down.
        let keep = attachments_held_by_chat_work().await?;
        ATTACHMENT_SERVICE
            .delete_orphans(ORPHAN_TTL_MS, &keep)
            .await
    };
    match orphans.await {
        Ok(deleted) => {
            if deleted > 0 {
                log_info!("[Attachments] reaped {} orphaned upload(s)", deleted);
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] orphan cleanup failed"
        ),
    }

    let scratch = async {
        // hydrate_attachment writes under the *thread's* workspace root (a TUI
        // thread's launch cwd), not only the default shell workspace — sweep
        // every root we know about or CLI repos accumulate .attachments dirs.
        let thread_roots: Vec<Option<String>> = crate::db::run(|conn| {
            Ok(t::conversation_threads
                .filter(t::workspace_root.is_not_null())
                .select(t::workspace_root)
                .distinct()
                .load(conn)?)
        })
        .await?;
        let mut reaped = 0;
        let roots = std::iter::once(None).chain(thread_roots);
        for root in roots {
            reaped += reap_scratch_dirs(root.as_deref(), ORPHAN_TTL_MS).await?;
        }
        anyhow::Ok(reaped)
    };
    match scratch.await {
        Ok(reaped) => {
            if reaped > 0 {
                log_info!("[Attachments] reaped {} stale scratch dir(s)", reaped);
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] scratch dir cleanup failed"
        ),
    }

    match ATTACHMENT_SERVICE
        .expire_content(CONFIG.attachment_content_ttl_ms)
        .await
    {
        Ok(expired) => {
            if expired > 0 {
                log_info!("[Attachments] expired content of {} attachment(s)", expired);
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] content expiry failed"
        ),
    }

    match ATTACHMENT_SERVICE.list_live_storage_paths().await {
        Ok(live) => {
            let strays = reap_stray_media_files(&live, STRAY_MEDIA_GRACE_MS).await;
            if strays > 0 {
                log_info!("[Attachments] reaped {} stray media file(s)", strays);
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] stray media cleanup failed"
        ),
    }

    let expired = reap_expired_tool_outputs(CONFIG.tool_output_ttl_ms).await;
    if expired > 0 {
        log_info!("[ToolOutput] reaped {} expired saved output(s)", expired);
    }
}

/// Sweep once now, then every hour. Returns the task so the caller can abort
/// it on shutdown; it never holds the process open.
pub async fn start_file_janitor() -> JoinHandle<()> {
    sweep_files().await;
    tokio::spawn(async {
        let period = Duration::from_millis(SWEEP_INTERVAL_MS);
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            interval.tick().await;
            // `setInterval` starts each sweep on its tick, whether or not the last one ended.
            tokio::spawn(sweep_files());
        }
    })
}
