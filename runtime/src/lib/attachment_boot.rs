//! Boot-time attachment storage reconciliation.
//!
//! Brings the attachment rows and the media dir back into agreement after a
//! `.prism` import onto another install, a lost volume, or an upgrade from the
//! legacy in-database BLOB storage. Runs once per process from `index.rs`.

/// Reconcile attachment storage, in dependency order. All three steps run
/// before listen() — acceptable because expiry runs first, so the backfill only
/// ever exports content younger than the TTL (bounded work).
///
/// 1. Rows pointing at media files that no longer exist (a `.prism` import
///    onto another install, a lost volume) go back to `storagePath = null`.
/// 2. Expire over-TTL content now — clearing legacy BLOBs *before* the
///    backfill, so a long-lived database doesn't write years of old BLOBs to
///    disk only to unlink them minutes later.
/// 3. Migrate the surviving legacy BLOB rows to media files (idempotent; a
///    migrated database matches nothing).
///
/// Every step catches its own failure. This runs inside `initialize()`, whose
/// error exits the process, and a container that won't boot is far worse than
/// an unreconciled row (a chip offering a download that 410s) — least of all
/// when the reconciliation that would fix the state is the thing failing.
/// Whatever fails here is logged and retried next boot.
///
/// `media_dir` is the media file root, reported with the backfill result.
pub async fn reconcile_attachment_storage(media_dir: &str) {
    todo!()
}
