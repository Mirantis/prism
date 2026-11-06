//! Attachment Service
//!
//! Owns all `MessageAttachment` DB access plus the media-type detection and
//! classification used by the upload route (web) and every channel's ingest
//! path. Content lives as files under `<dataDir>/media` (`lib/media_store.rs`);
//! the DB row keeps metadata plus the file's basename (`storagePath`). Legacy
//! rows may still carry a `data` BLOB until the boot-time backfill moves them —
//! `load_bytes()` is the one accessor that hides which of the two holds the
//! content, and returns `None` when neither does (content expired).
//!
//! Detection is allowlist-based on purpose: the Bedrock message converter
//! fails on an unknown mediaType in an image/file content part, which would
//! kill the whole `generate_text` call. So anything we can't confidently read
//! is classified `unreadable` and shown to the model as a plain text note
//! (see `prompts/context_builder.rs`).

use std::collections::HashSet;
use std::ops::{Deref, DerefMut};
use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::db::models::{ConversationMessage, MessageAttachment};
use crate::services::channel_adapter_interface::ChatPlatform;

/// The four categories the context builder understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentCategory {
    Image,
    Pdf,
    Text,
    Unreadable,
}

impl AttachmentCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachmentCategory::Image => "image",
            AttachmentCategory::Pdf => "pdf",
            AttachmentCategory::Text => "text",
            AttachmentCategory::Unreadable => "unreadable",
        }
    }

    /// The category a stored `category` column holds. A stored value is always
    /// one of the four, since only `classify_media_type` writes it.
    pub fn from_stored(value: &str) -> AttachmentCategory {
        match value {
            "image" => AttachmentCategory::Image,
            "pdf" => AttachmentCategory::Pdf,
            "text" => AttachmentCategory::Text,
            _ => AttachmentCategory::Unreadable,
        }
    }
}

/// Metadata-only view (no bytes) — safe to serialize into JSON responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: AttachmentCategory,
    /// Content no longer stored (168h TTL passed) — only metadata remains.
    /// True when the row has neither a media file (`storagePath`) nor a legacy
    /// BLOB. The BLOB presence is checked with an ids-only filtered query, never
    /// by selecting the bytes, so thread reads stay cheap; rows whose media file
    /// vanished out-of-band (lost volume, `.prism` import) are reconciled to
    /// `storagePath = null` at boot.
    pub expired: bool,
}

/// Where an attachment came from: `web` or a chat platform for inbound user
/// uploads, `agent` for a file the agent shared outbound via the `share_file` tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AttachmentSource {
    Web,
    Platform(ChatPlatform),
    Agent,
}

impl AttachmentSource {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachmentSource::Web => "web",
            AttachmentSource::Platform(platform) => platform.as_str(),
            AttachmentSource::Agent => "agent",
        }
    }
}

impl Serialize for AttachmentSource {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct CreateAttachmentInput {
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub data: Vec<u8>,
    pub category: AttachmentCategory,
    pub source: AttachmentSource,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
    /// The channel's own id for the file, unique across stored attachments.
    pub external_file_id: Option<String>,
    pub external_ts: Option<String>,
}

/// A value with the (no-bytes) metadata of the files it carries, serialized as
/// the value's own fields plus `attachments` when there are any.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WithAttachments<T> {
    #[serde(flatten)]
    pub inner: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentMeta>>,
}

impl<T> WithAttachments<T> {
    /// The value with no attachments.
    pub fn bare(inner: T) -> Self {
        Self {
            inner,
            attachments: None,
        }
    }
}

impl<T> Deref for WithAttachments<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}

impl<T> DerefMut for WithAttachments<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

impl<T> std::borrow::Borrow<T> for WithAttachments<T> {
    fn borrow(&self) -> &T {
        &self.inner
    }
}

/// A value keyed by the id of the message it stands for, so attachment metadata
/// can be joined onto it.
pub trait HasMessageId {
    fn message_id(&self) -> &str;
}

impl HasMessageId for ConversationMessage {
    fn message_id(&self) -> &str {
        &self.id
    }
}

impl<T: HasMessageId> HasMessageId for WithAttachments<T> {
    fn message_id(&self) -> &str {
        self.inner.message_id()
    }
}

/// What the boot-time BLOB backfill did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BackfillResult {
    pub migrated: i64,
    pub failed: i64,
}

// Bedrock natively understands exactly these image formats; emit image parts
// only for these (see getBedrockImageFormat in @ai-sdk/amazon-bedrock).
const IMAGE_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// `application/*` media types we still treat as inline-able text/code.
const TEXT_APPLICATION_TYPES: [&str; 6] = [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/x-sh",
];

// Extension → media type, used when magic-byte sniffing doesn't match.
// Code files map to a text/* type so they classify as `text` and get inlined.
//
// NOTE: image/pdf extensions are deliberately absent. Those types are only
// ever assigned from magic bytes (sniff_magic_bytes) — a valid image/PDF always
// carries its header, so an extension- or mime-based guess would only fire on
// a corrupt/mislabeled file, which would then be emitted as an image/file
// content part and fail the entire Bedrock turn. See detect_media_type's gate.
static EXT_MEDIA_TYPES: LazyLock<IndexMap<&'static str, &'static str>> = LazyLock::new(|| {
    IndexMap::from([
        ("txt", "text/plain"),
        ("text", "text/plain"),
        ("log", "text/plain"),
        ("md", "text/markdown"),
        ("markdown", "text/markdown"),
        ("csv", "text/csv"),
        ("tsv", "text/tab-separated-values"),
        ("json", "application/json"),
        ("xml", "application/xml"),
        ("html", "text/html"),
        ("htm", "text/html"),
        ("css", "text/css"),
        ("js", "application/javascript"),
        ("mjs", "application/javascript"),
        ("cjs", "application/javascript"),
        ("jsx", "text/plain"),
        ("ts", "application/typescript"),
        ("tsx", "text/plain"),
        ("py", "text/x-python"),
        ("rb", "text/x-ruby"),
        ("go", "text/x-go"),
        ("rs", "text/x-rust"),
        ("java", "text/x-java"),
        ("kt", "text/x-kotlin"),
        ("c", "text/x-c"),
        ("h", "text/x-c"),
        ("cpp", "text/x-c++"),
        ("hpp", "text/x-c++"),
        ("cc", "text/x-c++"),
        ("sh", "application/x-sh"),
        ("bash", "application/x-sh"),
        ("zsh", "application/x-sh"),
        ("yml", "application/x-yaml"),
        ("yaml", "application/x-yaml"),
        ("toml", "text/plain"),
        ("ini", "text/plain"),
        ("cfg", "text/plain"),
        ("conf", "text/plain"),
        ("env", "text/plain"),
        ("sql", "text/plain"),
    ])
});

/// True for the media types that become Bedrock image/file content parts.
fn is_image_or_pdf_type(media_type: &str) -> bool {
    IMAGE_MEDIA_TYPES.contains(&media_type) || media_type == "application/pdf"
}

/// Sniff well-known binary headers. Returns `None` when nothing matches.
fn sniff_magic_bytes(buf: &[u8]) -> Option<&'static str> {
    if buf.len() >= 4 && buf[..4] == [0x89, 0x50, 0x4e, 0x47] {
        return Some("image/png");
    }
    if buf.len() >= 3 && buf[..3] == [0xff, 0xd8, 0xff] {
        return Some("image/jpeg");
    }
    if buf.len() >= 4 && buf[..4] == [0x47, 0x49, 0x46, 0x38] {
        return Some("image/gif");
    }
    if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if buf.len() >= 5 && &buf[0..5] == b"%PDF-" {
        return Some("application/pdf");
    }
    None
}

/// True when the bytes are clean UTF-8 text (no NUL, valid encoding).
fn looks_like_utf8_text(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return false;
    }
    if buf.contains(&0) {
        return false;
    }
    std::str::from_utf8(buf).is_ok()
}

/// Best-effort media type for an uploaded file. Magic bytes win (clients lie
/// about `Content-Type`), then the extension map, then a UTF-8 text heuristic
/// so arbitrary code files still inline, else `application/octet-stream`.
pub fn detect_media_type(buffer: &[u8], filename: &str, declared_mime: Option<&str>) -> String {
    // Magic bytes are the ONLY source that may yield an image/pdf type — a valid
    // image/PDF always carries its header in a complete upload.
    if let Some(magic) = sniff_magic_bytes(buffer) {
        return magic.to_string();
    }

    let ext = if filename.contains('.') {
        filename.rsplit('.').next().unwrap_or("").to_lowercase()
    } else {
        String::new()
    };
    let declared = declared_mime.unwrap_or("");
    let resolved: String = if let Some(mapped) = (!ext.is_empty())
        .then(|| EXT_MEDIA_TYPES.get(ext.as_str()))
        .flatten()
    {
        mapped.to_string()
    } else if !declared.is_empty()
        && (declared.starts_with("text/") || declared == "application/json")
    {
        declared.to_string()
    } else if looks_like_utf8_text(buffer) {
        "text/plain".to_string()
    } else if !declared.is_empty() {
        declared.to_string()
    } else {
        "application/octet-stream".to_string()
    };

    // Invariant: image/pdf parts are only emitted for magic-confirmed files.
    // A `.png`/image-mime guess on bytes without the matching header (corrupt or
    // mislabeled) would be sent to Bedrock as an image/file part and fail the
    // whole turn — downgrade it to an unreadable binary instead.
    if is_image_or_pdf_type(&resolved) {
        "application/octet-stream".to_string()
    } else {
        resolved
    }
}

/// True for image media types Bedrock natively accepts as image content parts.
pub fn is_bedrock_image_type(media_type: &str) -> bool {
    IMAGE_MEDIA_TYPES.contains(&media_type)
}

/// Map a media type to the four categories the context builder understands.
pub fn classify_media_type(media_type: &str) -> AttachmentCategory {
    if IMAGE_MEDIA_TYPES.contains(&media_type) {
        return AttachmentCategory::Image;
    }
    if media_type == "application/pdf" {
        return AttachmentCategory::Pdf;
    }
    if media_type.starts_with("text/") || TEXT_APPLICATION_TYPES.contains(&media_type) {
        return AttachmentCategory::Text;
    }
    AttachmentCategory::Unreadable
}

/// How long attachment content is kept, in words: "7 days", "36 hours". The value
/// comes from `ATTACHMENT_TTL_HOURS`, read once at startup.
pub fn attachment_retention() -> String {
    let hours = crate::config::CONFIG.attachment_content_ttl_ms as f64 / 3_600_000.0;
    let (count, unit) = if hours % 24.0 == 0.0 {
        (hours / 24.0, "day")
    } else {
        (hours, "hour")
    };
    let plural = if count == 1.0 { "" } else { "s" };
    format!("{} {unit}{plural}", crate::support::js::number_text(count))
}

/// Human-readable byte size, e.g. "1.2 MB".
///
/// Kept in sync with `cli/src/attachments.ts#formatFileSize` and
/// `web/src/components/chat/ChatAttachmentChip.tsx#humanSize` — the three
/// workspaces can't import each other, so the formatter is mirrored.
pub fn human_file_size(bytes: i64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB"];
    let mut value = bytes as f64 / 1024.0;
    let mut i = 0;
    while value >= 1024.0 && i < units.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    format!("{} {}", to_fixed_1(value), units[i])
}

/// `Number.prototype.toFixed(1)` for a non-negative value: the exact value rounded
/// half up to one decimal, which differs from Rust's tie-to-even formatting.
fn to_fixed_1(value: f64) -> String {
    let exact = format!("{value:.30}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), "0"));
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes().take(1))
        .map(|b| b - b'0')
        .collect();
    let round_up = fraction.as_bytes().get(1).is_some_and(|&b| b >= b'5');
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let text: String = digits.iter().map(|d| char::from(b'0' + d)).collect();
    let (int_part, frac_part) = text.split_at(text.len() - 1);
    format!(
        "{}.{}",
        if int_part.is_empty() { "0" } else { int_part },
        frac_part
    )
}

/// The columns a metadata read selects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaRow {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: String,
    pub storage_path: Option<String>,
}

fn to_meta(row: &MetaRow, blob_backed_ids: &HashSet<String>) -> AttachmentMeta {
    AttachmentMeta {
        id: row.id.clone(),
        filename: row.filename.clone(),
        media_type: row.media_type.clone(),
        size_bytes: row.size_bytes,
        category: AttachmentCategory::from_stored(&row.category),
        expired: row.storage_path.is_none() && !blob_backed_ids.contains(&row.id),
    }
}

/// Ids per update in `reconcile_missing_files` — well under any SQLite bind-variable limit.
const RECONCILE_BATCH_SIZE: usize = 500;

pub struct AttachmentService;

impl AttachmentService {
    pub fn new() -> Self {
        AttachmentService
    }

    /// Persist an uploaded/downloaded file: bytes to the media dir, metadata to the DB.
    pub async fn create(&self, input: CreateAttachmentInput) -> anyhow::Result<MessageAttachment> {
        todo!()
    }

    /// Like `create()`, but idempotent on `external_file_id`: returns `None` when the
    /// file is already stored. The unique index on the column is the real de-dupe
    /// guarantee — this swallows the unique violation that a concurrent
    /// at-least-once channel redelivery races into past the
    /// `exists_by_external_file_id` pre-check.
    pub async fn create_once(
        &self,
        input: CreateAttachmentInput,
    ) -> anyhow::Result<Option<MessageAttachment>> {
        todo!()
    }

    /// Full row (metadata + storage handles) — bytes come from `load_bytes()`.
    pub async fn get_by_id(&self, id: &str) -> anyhow::Result<Option<MessageAttachment>> {
        todo!()
    }

    /// The one content accessor. Prefers the media file, falls back to the
    /// legacy BLOB (rows the boot backfill hasn't migrated), and returns `None`
    /// when neither exists — content expired, only metadata remains.
    pub async fn load_bytes(&self, row: &MessageAttachment) -> anyhow::Result<Option<Vec<u8>>> {
        todo!()
    }

    /// Of the rows without a media file, the ids that still hold a legacy BLOB —
    /// those are not expired, just not backfilled yet. Filters on `data` without
    /// ever selecting it, so no bytes are loaded. The common case (every row has
    /// a `storagePath`) costs no extra query.
    async fn blob_backed_ids(&self, rows: &[MetaRow]) -> anyhow::Result<HashSet<String>> {
        todo!()
    }

    /// Metadata only (no bytes) for the given message ids — for thread reads.
    pub async fn get_meta_by_message_ids(
        &self,
        message_ids: &[String],
    ) -> anyhow::Result<IndexMap<String, Vec<AttachmentMeta>>> {
        todo!()
    }

    /// Join attachment metadata (no bytes) onto messages by message id — the
    /// shared enrichment for thread-read endpoints, so the join shape lives in
    /// one place. A message with no attachments gets none.
    pub async fn attach_meta_to_messages<T: HasMessageId + Send>(
        &self,
        messages: Vec<T>,
    ) -> anyhow::Result<Vec<WithAttachments<T>>> {
        todo!()
    }

    /// Metadata only (no bytes) keyed by the carrying message's external id — for live-read threads.
    pub async fn get_meta_by_external_ts(
        &self,
        thread_id: &str,
        ts_list: &[String],
    ) -> anyhow::Result<IndexMap<String, Vec<AttachmentMeta>>> {
        todo!()
    }

    /// Metadata by attachment ids, in upload order.
    ///
    /// For files that must reach the model *before* they are linked to a message
    /// row: a message handed to a turn already in flight is folded into that turn
    /// directly, so the only handle its files have at that point is the id the
    /// upload returned.
    pub async fn get_meta_by_ids(
        &self,
        attachment_ids: &[String],
    ) -> anyhow::Result<Vec<AttachmentMeta>> {
        todo!()
    }

    /// Link pre-uploaded (web) attachments to the message that carries them.
    pub async fn link_to_message(
        &self,
        attachment_ids: &[String],
        message_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// True when a channel's file id was already stored (at-least-once redelivery).
    pub async fn exists_by_external_file_id(&self, external_file_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// Delete an unlinked (pre-send) attachment — used by chip removal. Returns deleted count.
    pub async fn delete_unlinked(&self, id: &str) -> anyhow::Result<i64> {
        todo!()
    }

    /// One-time (idempotent) migration of legacy BLOB rows to media files. Runs
    /// at every boot; a fully-migrated database matches zero rows and no-ops.
    ///
    /// One row at a time on purpose — bounds memory at one file (≤10 MB) instead
    /// of loading every BLOB at once. Per row: write the file, then a single
    /// UPDATE sets storagePath and clears the BLOB (atomic in SQLite, so there is
    /// no state with the content in neither place). A failed row keeps its BLOB —
    /// it still serves through `load_bytes()` and retries next boot. A failed row
    /// is counted and logged, never returned as an error: an unmigrated row is
    /// fully functional, just legacy-shaped.
    pub async fn backfill_blobs_to_files(&self) -> anyhow::Result<BackfillResult> {
        todo!()
    }

    /// Expire attachment content older than the TTL: delete the media file and
    /// clear both storage columns in one UPDATE. The metadata row survives so
    /// the conversation keeps its stub; `load_bytes()` then returns `None` and every
    /// consumer (download route, hydrate/view tools) reports "content expired".
    /// Also expires never-backfilled legacy BLOB rows. Returns the expired count.
    pub async fn expire_content(&self, older_than_ms: i64) -> anyhow::Result<i64> {
        todo!()
    }

    /// The set of media-file basenames the database still references — everything
    /// else in the media dir is stray and eligible for `reap_stray_media_files`.
    pub async fn list_live_storage_paths(&self) -> anyhow::Result<HashSet<String>> {
        todo!()
    }

    /// Reap abandoned pre-send uploads that never got linked to a message, except the ids in `keep`.
    pub async fn delete_orphans(&self, older_than_ms: i64, keep: &[String]) -> anyhow::Result<i64> {
        todo!()
    }

    /// Repoint rows whose media file is gone out-of-band — a `.prism` import onto
    /// a different install, a lost/replaced volume — back to `storagePath = null`
    /// so `expired` tells the truth (the web chip stops offering a download that
    /// would 410, and the stub stops advertising tools that would fail). Runs at
    /// boot, before the backfill: an imported row that still has a legacy BLOB is
    /// then re-exported to a real local file. One readdir, no byte reads.
    pub async fn reconcile_missing_files(&self) -> anyhow::Result<i64> {
        todo!()
    }
}

impl Default for AttachmentService {
    fn default() -> Self {
        Self::new()
    }
}

pub static ATTACHMENT_SERVICE: LazyLock<AttachmentService> = LazyLock::new(AttachmentService::new);
