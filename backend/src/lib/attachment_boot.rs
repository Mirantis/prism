//! Boot-time attachment storage reconciliation.
//!
//! Brings the attachment rows and the media dir back into agreement after a
//! `.prism` import onto another install, a lost volume, or an upgrade from the
//! legacy in-database BLOB storage. Runs once per process from `index.rs`.

use serde_json::json;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::{log_error, log_info, log_warn};

/// Reconcile attachment storage, in dependency order. All three steps run
/// before listen() — acceptable because expiry runs first, so the backfill only
/// ever exports content younger than the TTL (bounded work).
///
/// Every step catches its own failure. This runs inside `initialize()`, whose
/// error exits the process, and a container that won't boot is far worse than
/// an unreconciled row (a chip offering a download that 410s) — least of all
/// when the reconciliation that would fix the state is the thing failing.
/// Whatever fails here is logged and retried next boot.
///
/// `media_dir` is the media file root, reported with the backfill result.
pub async fn reconcile_attachment_storage(media_dir: &str) {
    // 1. Rows pointing at media files that no longer exist (a `.prism` import
    //    onto another install, a lost volume) go back to storagePath = null.
    match ATTACHMENT_SERVICE.reconcile_missing_files().await {
        Ok(reconciled) => {
            if reconciled > 0 {
                log_warn!(
                    "[Attachments] {} row(s) pointed at missing media files; marked expired",
                    reconciled
                );
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] boot reconciliation of missing media files failed"
        ),
    }

    // 2. Expire over-TTL content now — clearing legacy BLOBs *before* the
    //    backfill, so a long-lived database doesn't write years of old BLOBs to
    //    disk only to unlink them minutes later.
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
            "[Attachments] boot content expiry failed"
        ),
    }

    // 3. Migrate the surviving legacy BLOB rows to media files (idempotent; a
    //    migrated database matches nothing).
    match ATTACHMENT_SERVICE.backfill_blobs_to_files().await {
        Ok(backfill) => {
            if backfill.migrated > 0 || backfill.failed > 0 {
                log_info!(
                    "[Attachments] backfilled {} BLOB row(s) to {} ({} failed)",
                    backfill.migrated,
                    media_dir,
                    backfill.failed
                );
            }
        }
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[Attachments] boot BLOB backfill failed"
        ),
    }
}
