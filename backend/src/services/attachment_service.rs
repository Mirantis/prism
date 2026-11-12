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

use diesel::prelude::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::config::CONFIG;
use crate::constants::MAX_ATTACHMENTS_PER_MESSAGE;
use crate::db::models::{ConversationMessage, MessageAttachment, NewMessageAttachment};
use crate::db::schema::message_attachments::dsl as a;
use crate::db::sql_types::DbDateTime;
use crate::lib::log_redaction::err_json;
use crate::lib::media_store::{
    list_media_files, read_media_file, remove_media_file, write_media_file,
};
use crate::lib::telemetry::track_event;
use crate::services::channel_adapter_interface::ChatPlatform;
use crate::{log_error, log_warn};

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

/// The meta columns, plus the key a read groups by.
type MetaTuple = (String, String, String, i64, String, Option<String>);

fn meta_row(t: MetaTuple) -> MetaRow {
    MetaRow {
        id: t.0,
        filename: t.1,
        media_type: t.2,
        size_bytes: t.3,
        category: t.4,
        storage_path: t.5,
    }
}

/// Whether a database error is a unique-constraint violation (Prisma's `P2002`).
fn is_unique_violation(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<diesel::result::Error>(),
        Some(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _
        ))
    )
}

/// The error Prisma's `update` gives when no row has the id.
fn record_not_found() -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for an update."
    )
}

/// `{ 'agent.id': config.agentId }` when an agent id is set, as the first prop.
fn agent_props() -> IndexMap<String, String> {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props
}

impl AttachmentService {
    pub fn new() -> Self {
        AttachmentService
    }

    /// Persist an uploaded/downloaded file: bytes to the media dir, metadata to the DB.
    pub async fn create(&self, input: CreateAttachmentInput) -> anyhow::Result<MessageAttachment> {
        // Id first so the content file exists before the row that references it —
        // a reader that sees the row can always read the file. The reverse order
        // would leave a window where the row points at nothing.
        let id = Uuid::new_v4().to_string();
        let storage_path = write_media_file(&id, &input.filename, &input.data).await?;
        let mut new_row = NewMessageAttachment::new(
            input.filename.clone(),
            input.media_type.clone(),
            input.size_bytes,
            input.category.as_str(),
            input.source.as_str(),
        );
        new_row.id = id;
        new_row.storage_path = Some(storage_path.clone());
        new_row.thread_id = input.thread_id.clone();
        new_row.message_id = input.message_id.clone();
        new_row.slack_file_id = input.external_file_id.clone();
        new_row.external_ts = input.external_ts.clone();
        let inserted = crate::db::run(move |conn| {
            Ok(diesel::insert_into(a::message_attachments)
                .values(&new_row)
                .returning(MessageAttachment::as_returning())
                .get_result(conn)?)
        })
        .await;
        let row = match inserted {
            Ok(row) => row,
            Err(err) => {
                // Row never landed (e.g. a channel redelivery losing the external file
                // id unique race) — the content file is unreachable, remove it now
                // rather than leaving it to the stray-file reaper.
                remove_media_file(&storage_path).await;
                return Err(err);
            }
        };
        // No filename in telemetry — it can reveal private information.
        let mut props = agent_props();
        props.insert("attachment.id".to_string(), row.id.clone());
        props.insert(
            "attachment.category".to_string(),
            input.category.as_str().to_string(),
        );
        props.insert(
            "attachment.media_type".to_string(),
            input.media_type.clone(),
        );
        props.insert(
            "attachment.size_bytes".to_string(),
            input.size_bytes.to_string(),
        );
        props.insert(
            "attachment.source".to_string(),
            input.source.as_str().to_string(),
        );
        track_event("attachment uploaded", None, Some(props));
        Ok(row)
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
        match self.create(input).await {
            Ok(row) => Ok(Some(row)),
            Err(err) if is_unique_violation(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Full row (metadata + storage handles) — bytes come from `load_bytes()`.
    pub async fn get_by_id(&self, id: &str) -> anyhow::Result<Option<MessageAttachment>> {
        let id = id.to_string();
        crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::id.eq(&id))
                .select(MessageAttachment::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// The one content accessor. Prefers the media file, falls back to the
    /// legacy BLOB (rows the boot backfill hasn't migrated), and returns `None`
    /// when neither exists — content expired, only metadata remains.
    pub async fn load_bytes(&self, row: &MessageAttachment) -> anyhow::Result<Option<Vec<u8>>> {
        load_stored_bytes(row.storage_path.as_deref(), row.data.as_deref()).await
    }

    /// Of the rows without a media file, the ids that still hold a legacy BLOB —
    /// those are not expired, just not backfilled yet. Filters on `data` without
    /// ever selecting it, so no bytes are loaded. The common case (every row has
    /// a `storagePath`) costs no extra query.
    async fn blob_backed_ids(&self, rows: &[MetaRow]) -> anyhow::Result<HashSet<String>> {
        let candidates: Vec<String> = rows
            .iter()
            .filter(|r| r.storage_path.is_none())
            .map(|r| r.id.clone())
            .collect();
        if candidates.is_empty() {
            return Ok(HashSet::new());
        }
        let backed: Vec<String> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::id.eq_any(&candidates))
                .filter(a::data.is_not_null())
                .select(a::id)
                .load(conn)?)
        })
        .await?;
        Ok(backed.into_iter().collect())
    }

    /// Metadata only (no bytes) for the given message ids — for thread reads.
    pub async fn get_meta_by_message_ids(
        &self,
        message_ids: &[String],
    ) -> anyhow::Result<IndexMap<String, Vec<AttachmentMeta>>> {
        let mut map: IndexMap<String, Vec<AttachmentMeta>> = IndexMap::new();
        if message_ids.is_empty() {
            return Ok(map);
        }
        let ids = message_ids.to_vec();
        let rows: Vec<(MetaTuple, Option<String>)> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::message_id.eq_any(&ids))
                .order(a::created_at.asc())
                .select((
                    (
                        a::id,
                        a::filename,
                        a::media_type,
                        a::size_bytes,
                        a::category,
                        a::storage_path,
                    ),
                    a::message_id,
                ))
                .load(conn)?)
        })
        .await?;
        let rows: Vec<(MetaRow, Option<String>)> = rows
            .into_iter()
            .map(|(t, key)| (meta_row(t), key))
            .collect();
        let metas: Vec<MetaRow> = rows.iter().map(|(row, _)| row.clone()).collect();
        let blob_backed = self.blob_backed_ids(&metas).await?;
        for (row, message_id) in rows {
            let Some(message_id) = message_id else {
                continue;
            };
            map.entry(message_id)
                .or_default()
                .push(to_meta(&row, &blob_backed));
        }
        Ok(map)
    }

    /// Join attachment metadata (no bytes) onto messages by message id — the
    /// shared enrichment for thread-read endpoints, so the join shape lives in
    /// one place. A message with no attachments gets none.
    pub async fn attach_meta_to_messages<T: HasMessageId + Send>(
        &self,
        messages: Vec<T>,
    ) -> anyhow::Result<Vec<WithAttachments<T>>> {
        if messages.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = messages
            .iter()
            .map(|m| m.message_id().to_string())
            .collect();
        let meta_map = self.get_meta_by_message_ids(&ids).await?;
        if meta_map.is_empty() {
            return Ok(messages.into_iter().map(WithAttachments::bare).collect());
        }
        Ok(messages
            .into_iter()
            .map(|m| {
                let attachments = meta_map
                    .get(m.message_id())
                    .filter(|list| !list.is_empty())
                    .cloned();
                WithAttachments {
                    inner: m,
                    attachments,
                }
            })
            .collect())
    }

    /// Metadata only (no bytes) keyed by the carrying message's external id — for live-read threads.
    pub async fn get_meta_by_external_ts(
        &self,
        thread_id: &str,
        ts_list: &[String],
    ) -> anyhow::Result<IndexMap<String, Vec<AttachmentMeta>>> {
        let mut map: IndexMap<String, Vec<AttachmentMeta>> = IndexMap::new();
        if ts_list.is_empty() {
            return Ok(map);
        }
        let thread_id = thread_id.to_string();
        let ts_list = ts_list.to_vec();
        let rows: Vec<(MetaTuple, Option<String>)> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::thread_id.eq(&thread_id))
                .filter(a::external_ts.eq_any(&ts_list))
                .order(a::created_at.asc())
                .select((
                    (
                        a::id,
                        a::filename,
                        a::media_type,
                        a::size_bytes,
                        a::category,
                        a::storage_path,
                    ),
                    a::external_ts,
                ))
                .load(conn)?)
        })
        .await?;
        let rows: Vec<(MetaRow, Option<String>)> = rows
            .into_iter()
            .map(|(t, key)| (meta_row(t), key))
            .collect();
        let metas: Vec<MetaRow> = rows.iter().map(|(row, _)| row.clone()).collect();
        let blob_backed = self.blob_backed_ids(&metas).await?;
        for (row, external_ts) in rows {
            let Some(external_ts) = external_ts else {
                continue;
            };
            map.entry(external_ts)
                .or_default()
                .push(to_meta(&row, &blob_backed));
        }
        Ok(map)
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
        if attachment_ids.is_empty() {
            return Ok(Vec::new());
        }
        let ids = attachment_ids.to_vec();
        let rows: Vec<MetaTuple> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::id.eq_any(&ids))
                .order(a::created_at.asc())
                .select((
                    a::id,
                    a::filename,
                    a::media_type,
                    a::size_bytes,
                    a::category,
                    a::storage_path,
                ))
                .load(conn)?)
        })
        .await?;
        let rows: Vec<MetaRow> = rows.into_iter().map(meta_row).collect();
        let blob_backed = self.blob_backed_ids(&rows).await?;
        Ok(rows.iter().map(|row| to_meta(row, &blob_backed)).collect())
    }

    /// Link pre-uploaded (web) attachments to the message that carries them.
    pub async fn link_to_message(
        &self,
        attachment_ids: &[String],
        message_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<()> {
        if attachment_ids.is_empty() {
            return Ok(());
        }
        // Authoritative count cap (every upload path funnels through here). Bounds
        // the per-message stub count in the LLM context and the media-dir write
        // volume a single message can cause. Excess ids stay unlinked and the
        // orphan janitor reaps them. The ids are client-controlled, so this can't
        // be trusted to the UI caps alone.
        let capped: Vec<String> = attachment_ids
            .iter()
            .take(MAX_ATTACHMENTS_PER_MESSAGE)
            .cloned()
            .collect();
        if capped.len() < attachment_ids.len() {
            log_warn!(
                "[Attachments] message {} exceeded the {}-attachment cap ({} requested); linking first {}",
                message_id,
                MAX_ATTACHMENTS_PER_MESSAGE,
                attachment_ids.len(),
                capped.len()
            );
        }
        let message_id = message_id.to_string();
        let thread_id = thread_id.to_string();
        crate::db::run(move |conn| {
            // Only pre-send (unlinked) uploads may be claimed — the ids are a
            // client-controlled field, and a replayed/forged id must not steal an
            // attachment from the message it already belongs to.
            diesel::update(
                a::message_attachments
                    .filter(a::id.eq_any(&capped))
                    .filter(a::message_id.is_null()),
            )
            .set((
                a::message_id.eq(Some(&message_id)),
                a::thread_id.eq(Some(&thread_id)),
            ))
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// True when a channel's file id was already stored (at-least-once redelivery).
    pub async fn exists_by_external_file_id(&self, external_file_id: &str) -> anyhow::Result<bool> {
        let external_file_id = external_file_id.to_string();
        let row: Option<String> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::slack_file_id.eq(&external_file_id))
                .select(a::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        Ok(row.is_some())
    }

    /// Delete an unlinked (pre-send) attachment — used by chip removal. Returns deleted count.
    pub async fn delete_unlinked(&self, id: &str) -> anyhow::Result<i64> {
        let id_owned = id.to_string();
        // Capture the file handle before the row goes — after the delete nothing
        // references it and only the slow stray-file reaper would find it.
        let (victim, count) = crate::db::run(move |conn| {
            let victim: Option<Option<String>> = a::message_attachments
                .filter(a::id.eq(&id_owned))
                .filter(a::message_id.is_null())
                .select(a::storage_path)
                .first(conn)
                .optional()?;
            let count = diesel::delete(
                a::message_attachments
                    .filter(a::id.eq(&id_owned))
                    .filter(a::message_id.is_null()),
            )
            .execute(conn)?;
            Ok((victim, count as i64))
        })
        .await?;
        if count > 0 {
            if let Some(Some(storage_path)) = victim {
                remove_media_file(&storage_path).await;
            }
            let mut props = agent_props();
            props.insert("attachment.id".to_string(), id.to_string());
            track_event("attachment deleted", None, Some(props));
        }
        Ok(count)
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
        let candidates: Vec<String> = crate::db::run(|conn| {
            Ok(a::message_attachments
                .filter(a::storage_path.is_null())
                .filter(a::data.is_not_null())
                .select(a::id)
                .load(conn)?)
        })
        .await?;
        let mut result = BackfillResult::default();
        for id in candidates {
            match self.backfill_one(&id).await {
                Ok(true) => result.migrated += 1,
                Ok(false) => {} // raced away (deleted or already migrated)
                Err(err) => {
                    result.failed += 1;
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[Attachments] backfill failed for {}; BLOB kept",
                        id
                    );
                }
            }
        }
        Ok(result)
    }

    /// Moves one row's BLOB to a media file. False when the row no longer holds one.
    async fn backfill_one(&self, id: &str) -> anyhow::Result<bool> {
        let Some(row) = self.get_by_id(id).await? else {
            return Ok(false);
        };
        let Some(bytes) = row.data else {
            return Ok(false);
        };
        let storage_path = write_media_file(id, &row.filename, &bytes).await?;
        let id = id.to_string();
        let updated = crate::db::run(move |conn| {
            Ok(diesel::update(a::message_attachments.filter(a::id.eq(&id)))
                .set((
                    a::storage_path.eq(Some(storage_path)),
                    a::data.eq(None::<Vec<u8>>),
                ))
                .execute(conn)?)
        })
        .await?;
        if updated == 0 {
            return Err(record_not_found());
        }
        Ok(true)
    }

    /// Expire attachment content older than the TTL: delete the media file and
    /// clear both storage columns in one UPDATE. The metadata row survives so
    /// the conversation keeps its stub; `load_bytes()` then returns `None` and every
    /// consumer (download route, hydrate/view tools) reports "content expired".
    /// Also expires never-backfilled legacy BLOB rows. Returns the expired count.
    pub async fn expire_content(&self, older_than_ms: i64) -> anyhow::Result<i64> {
        let cutoff = DbDateTime(crate::support::from_ms(
            crate::support::now_ms() - older_than_ms,
        ));
        let victims: Vec<(String, Option<String>)> = crate::db::run(move |conn| {
            Ok(a::message_attachments
                .filter(a::created_at.lt(cutoff))
                .filter(a::storage_path.is_not_null().or(a::data.is_not_null()))
                .select((a::id, a::storage_path))
                .load(conn)?)
        })
        .await?;
        let mut expired = 0;
        for (id, storage_path) in victims {
            let row_id = id.clone();
            let cleared = crate::db::run(move |conn| {
                let updated = diesel::update(a::message_attachments.filter(a::id.eq(&row_id)))
                    .set((
                        a::storage_path.eq(None::<String>),
                        a::data.eq(None::<Vec<u8>>),
                    ))
                    .execute(conn)?;
                if updated == 0 {
                    return Err(record_not_found());
                }
                Ok(())
            })
            .await;
            match cleared {
                Ok(()) => {
                    if let Some(storage_path) = storage_path {
                        remove_media_file(&storage_path).await;
                    }
                    expired += 1;
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[Attachments] failed to expire content of {}",
                        id
                    );
                }
            }
        }
        Ok(expired)
    }

    /// The set of media-file basenames the database still references — everything
    /// else in the media dir is stray and eligible for `reap_stray_media_files`.
    pub async fn list_live_storage_paths(&self) -> anyhow::Result<HashSet<String>> {
        let rows: Vec<Option<String>> = crate::db::run(|conn| {
            Ok(a::message_attachments
                .filter(a::storage_path.is_not_null())
                .select(a::storage_path)
                .load(conn)?)
        })
        .await?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// Reap abandoned pre-send uploads that never got linked to a message, except the ids in `keep`.
    pub async fn delete_orphans(&self, older_than_ms: i64, keep: &[String]) -> anyhow::Result<i64> {
        let cutoff = DbDateTime(crate::support::from_ms(
            crate::support::now_ms() - older_than_ms,
        ));
        let keep = keep.to_vec();
        let victims: Vec<(String, Option<String>)> = crate::db::run(move |conn| {
            let mut query = a::message_attachments
                .filter(a::message_id.is_null())
                .filter(a::created_at.lt(cutoff))
                .select((a::id, a::storage_path))
                .into_boxed();
            if !keep.is_empty() {
                query = query.filter(a::id.ne_all(keep));
            }
            Ok(query.load(conn)?)
        })
        .await?;
        let mut deleted = 0;
        for (id, storage_path) in victims {
            // Re-check `message_id IS NULL` in the delete itself: a send can link the
            // row between the scan and here, and a just-linked attachment (and its
            // media file) must survive. Per-row deletes so the file is only removed
            // when its row actually went.
            let count = crate::db::run(move |conn| {
                Ok(diesel::delete(
                    a::message_attachments
                        .filter(a::id.eq(&id))
                        .filter(a::message_id.is_null()),
                )
                .execute(conn)? as i64)
            })
            .await?;
            if count > 0 {
                deleted += count;
                if let Some(storage_path) = storage_path {
                    remove_media_file(&storage_path).await;
                }
            }
        }
        Ok(deleted)
    }

    /// Repoint rows whose media file is gone out-of-band — a `.prism` import onto
    /// a different install, a lost/replaced volume — back to `storagePath = null`
    /// so `expired` tells the truth (the web chip stops offering a download that
    /// would 410, and the stub stops advertising tools that would fail). Runs at
    /// boot, before the backfill: an imported row that still has a legacy BLOB is
    /// then re-exported to a real local file. One readdir, no byte reads.
    pub async fn reconcile_missing_files(&self) -> anyhow::Result<i64> {
        let rows: Vec<(String, Option<String>)> = crate::db::run(|conn| {
            Ok(a::message_attachments
                .filter(a::storage_path.is_not_null())
                .select((a::id, a::storage_path))
                .load(conn)?)
        })
        .await?;
        if rows.is_empty() {
            return Ok(0);
        }
        let present = list_media_files().await;
        let missing: Vec<String> = rows
            .into_iter()
            .filter(|(_, path)| path.as_ref().is_some_and(|p| !present.contains(p)))
            .map(|(id, _)| id)
            .collect();
        if missing.is_empty() {
            return Ok(0);
        }
        // Repoint in batches. In the scenarios this method exists for (import onto
        // another install, replaced volume) *every* row is missing, so one `IN`
        // list would hold the whole table — past SQLite's bind-variable ceiling
        // that fails, at boot, on every restart.
        for batch in missing.chunks(RECONCILE_BATCH_SIZE) {
            let batch = batch.to_vec();
            crate::db::run(move |conn| {
                diesel::update(a::message_attachments.filter(a::id.eq_any(&batch)))
                    .set(a::storage_path.eq(None::<String>))
                    .execute(conn)?;
                Ok(())
            })
            .await?;
        }
        Ok(missing.len() as i64)
    }
}

/// `load_bytes` over the two storage columns.
async fn load_stored_bytes(
    storage_path: Option<&str>,
    data: Option<&[u8]>,
) -> anyhow::Result<Option<Vec<u8>>> {
    if let Some(storage_path) = storage_path.filter(|p| !p.is_empty())
        && let Some(bytes) = read_media_file(storage_path).await?
    {
        return Ok(Some(bytes));
    }
    Ok(data.map(<[u8]>::to_vec))
}

impl Default for AttachmentService {
    fn default() -> Self {
        Self::new()
    }
}

pub static ATTACHMENT_SERVICE: LazyLock<AttachmentService> = LazyLock::new(AttachmentService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;
    use crate::lib::media_store::tests::DataDirGuard;

    // Minimal valid magic-byte headers.
    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0];
    const GIF: &[u8] = b"GIF89a  ";
    const PDF: &[u8] = "%PDF-1.7\n…".as_bytes();

    fn webp() -> Vec<u8> {
        let mut b = vec![0u8; 16];
        b[0..4].copy_from_slice(b"RIFF");
        b[8..12].copy_from_slice(b"WEBP");
        b
    }

    #[test]
    fn detects_image_formats_from_magic_bytes_regardless_of_declared_mime() {
        assert_eq!(
            detect_media_type(PNG, "x.bin", Some("application/octet-stream")),
            "image/png"
        );
        assert_eq!(
            detect_media_type(JPEG, "photo", Some("text/plain")),
            "image/jpeg"
        );
        assert_eq!(detect_media_type(GIF, "anim.gif", None), "image/gif");
        assert_eq!(detect_media_type(&webp(), "img.webp", None), "image/webp");
    }

    #[test]
    fn detects_pdf_from_the_pdf_header() {
        assert_eq!(detect_media_type(PDF, "report", None), "application/pdf");
    }

    #[test]
    fn falls_back_to_the_extension_map_for_text_and_code_files() {
        assert_eq!(
            detect_media_type(b"hello", "notes.md", None),
            "text/markdown"
        );
        assert_eq!(detect_media_type(b"a,b,c", "data.csv", None), "text/csv");
        assert_eq!(
            detect_media_type(b"{}", "config.json", None),
            "application/json"
        );
        assert_eq!(
            detect_media_type(b"print(1)", "main.py", None),
            "text/x-python"
        );
    }

    #[test]
    fn treats_clean_utf8_with_an_unknown_extension_as_text_plain() {
        assert_eq!(
            detect_media_type(b"just some text content", "LICENSE", None),
            "text/plain"
        );
    }

    #[test]
    fn treats_binary_with_nul_bytes_and_unknown_extension_as_octet_stream() {
        let binary = [0x00, 0x01, 0x02, 0xff, 0x00];
        assert_eq!(
            detect_media_type(&binary, "mystery", None),
            "application/octet-stream"
        );
    }

    #[test]
    fn treats_an_empty_buffer_as_octet_stream() {
        assert_eq!(
            detect_media_type(&[], "empty", None),
            "application/octet-stream"
        );
    }

    #[test]
    fn never_yields_an_image_or_pdf_type_without_magic_bytes() {
        let garbage = [0x00, 0x01, 0x02, 0x03, 0xff];
        assert_eq!(
            detect_media_type(&garbage, "photo.png", Some("image/png")),
            "application/octet-stream"
        );
        assert_eq!(
            detect_media_type(&garbage, "doc.pdf", Some("application/pdf")),
            "application/octet-stream"
        );
        assert_eq!(
            detect_media_type(&garbage, "x.webp", None),
            "application/octet-stream"
        );
        assert_eq!(
            detect_media_type(PNG, "photo.png", Some("image/png")),
            "image/png"
        );
        assert_eq!(detect_media_type(PDF, "doc.pdf", None), "application/pdf");
    }

    #[test]
    fn classifies_the_bedrock_safe_image_set_as_image() {
        for t in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            assert_eq!(classify_media_type(t), AttachmentCategory::Image);
        }
    }

    #[test]
    fn classifies_pdf_text_and_everything_else() {
        assert_eq!(
            classify_media_type("application/pdf"),
            AttachmentCategory::Pdf
        );
        assert_eq!(classify_media_type("text/plain"), AttachmentCategory::Text);
        assert_eq!(
            classify_media_type("text/markdown"),
            AttachmentCategory::Text
        );
        assert_eq!(
            classify_media_type("application/json"),
            AttachmentCategory::Text
        );
        assert_eq!(
            classify_media_type("application/x-yaml"),
            AttachmentCategory::Text
        );
        assert_eq!(
            classify_media_type("application/zip"),
            AttachmentCategory::Unreadable
        );
        assert_eq!(
            classify_media_type("application/octet-stream"),
            AttachmentCategory::Unreadable
        );
        assert_eq!(
            classify_media_type("image/tiff"),
            AttachmentCategory::Unreadable
        );
        assert_eq!(
            classify_media_type("application/vnd.ms-excel"),
            AttachmentCategory::Unreadable
        );
    }

    #[test]
    fn is_bedrock_image_type_only_for_the_four_formats() {
        assert!(is_bedrock_image_type("image/png"));
        assert!(is_bedrock_image_type("image/webp"));
        assert!(!is_bedrock_image_type("image/tiff"));
        assert!(!is_bedrock_image_type("image/svg+xml"));
    }

    #[test]
    fn formats_bytes_kb_and_mb() {
        assert_eq!(human_file_size(512), "512 B");
        assert_eq!(human_file_size(2048), "2.0 KB");
        assert_eq!(human_file_size(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(human_file_size(1229), "1.2 KB");
    }

    #[test]
    fn retention_reads_whole_days_from_the_default_ttl() {
        // The test configuration keeps the default `ATTACHMENT_TTL_HOURS` (168).
        assert_eq!(attachment_retention(), "7 days");
    }

    fn input(filename: &str, data: &[u8]) -> CreateAttachmentInput {
        CreateAttachmentInput {
            filename: filename.to_string(),
            media_type: "image/png".to_string(),
            size_bytes: data.len() as i64,
            data: data.to_vec(),
            category: AttachmentCategory::Image,
            source: AttachmentSource::Web,
            thread_id: None,
            message_id: None,
            external_file_id: None,
            external_ts: None,
        }
    }

    fn row(id: &str) -> MessageAttachment {
        crate::db::run_sync({
            let id = id.to_string();
            move |conn| {
                Ok(a::message_attachments
                    .filter(a::id.eq(&id))
                    .select(MessageAttachment::as_select())
                    .first(conn)?)
            }
        })
        .unwrap()
    }

    fn insert(new_row: NewMessageAttachment) {
        crate::db::run_sync(move |conn| {
            diesel::insert_into(a::message_attachments)
                .values(&new_row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    fn legacy_row(id: &str, data: Option<&[u8]>, storage_path: Option<&str>, age_ms: i64) {
        let mut new_row =
            NewMessageAttachment::new(format!("{id}.txt"), "text/plain", 3, "text", "web");
        new_row.id = id.to_string();
        new_row.data = data.map(<[u8]>::to_vec);
        new_row.storage_path = storage_path.map(str::to_string);
        new_row.created_at = DbDateTime(crate::support::from_ms(crate::support::now_ms() - age_ms));
        insert(new_row);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn create_writes_the_content_file_first_and_persists_storage_path_never_a_blob() {
        let _db = test_db();
        let g = DataDirGuard::new();
        let created = ATTACHMENT_SERVICE
            .create(input("pic.png", &[1, 2, 3]))
            .await
            .unwrap();

        let storage_path = created.storage_path.clone().unwrap();
        // The pre-generated id is the one the file was written under.
        assert_eq!(storage_path, format!("{}-pic.png", created.id));
        assert_eq!(created.data, None);
        assert_eq!(
            std::fs::read(g.media_dir().join(&storage_path)).unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(row(&created.id).storage_path, Some(storage_path));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn create_removes_the_content_file_when_the_row_insert_fails() {
        let _db = test_db();
        let g = DataDirGuard::new();
        let mut first = input("pic.png", &[1, 2, 3]);
        first.external_file_id = Some("F1".to_string());
        ATTACHMENT_SERVICE.create(first.clone()).await.unwrap();

        let err = ATTACHMENT_SERVICE.create(first.clone()).await.unwrap_err();
        assert!(is_unique_violation(&err));
        // Only the first row's file remains.
        assert_eq!(std::fs::read_dir(g.media_dir()).unwrap().count(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn create_once_returns_the_row_then_none_for_a_stored_external_file_id() {
        let _db = test_db();
        let _g = DataDirGuard::new();
        let mut first = input("pic.png", &[1, 2, 3]);
        first.external_file_id = Some("F1".to_string());
        assert!(
            ATTACHMENT_SERVICE
                .create_once(first.clone())
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            ATTACHMENT_SERVICE
                .create_once(first)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            ATTACHMENT_SERVICE
                .exists_by_external_file_id("F1")
                .await
                .unwrap()
        );
        assert!(
            !ATTACHMENT_SERVICE
                .exists_by_external_file_id("F2")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn load_bytes_prefers_the_media_file_then_the_blob_then_none() {
        let _g = DataDirGuard::new();
        let path = write_media_file("id", "x.txt", b"file-bytes")
            .await
            .unwrap();
        assert_eq!(
            load_stored_bytes(Some(&path), Some(b"blob")).await.unwrap(),
            Some(b"file-bytes".to_vec())
        );
        assert_eq!(
            load_stored_bytes(Some("id-gone.txt"), Some(b"blob"))
                .await
                .unwrap(),
            Some(b"blob".to_vec())
        );
        assert_eq!(load_stored_bytes(None, None).await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn link_to_message_only_claims_unlinked_attachments_and_caps_at_100() {
        let _db = test_db();
        let _g = DataDirGuard::new();
        let mut ids = Vec::new();
        for i in 0..150 {
            let mut new_row =
                NewMessageAttachment::new(format!("{i}.txt"), "text/plain", 1, "text", "web");
            new_row.id = format!("att-{i}");
            new_row.storage_path = Some(format!("att-{i}-{i}.txt"));
            ids.push(new_row.id.clone());
            insert(new_row);
        }
        // A message and thread the foreign keys accept.
        crate::db::run_sync(|conn| {
            let mut agent = crate::db::models::NewAgentWorkspace::new("u", "", "", "", "", "");
            agent.id = "agent-1".to_string();
            diesel::insert_into(crate::db::schema::agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
            let mut thread = crate::db::models::NewConversationThread::new("agent-1", "u");
            thread.id = "thread-9".to_string();
            diesel::insert_into(crate::db::schema::conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            for id in ["msg-9", "msg-1"] {
                let mut message = crate::db::models::NewConversationMessage::new(
                    "thread-9",
                    crate::db::models::MessageRole::User,
                    "hi",
                    crate::db::models::MessageTrigger::UserInput,
                );
                message.id = id.to_string();
                diesel::insert_into(crate::db::schema::conversation_messages::table)
                    .values(&message)
                    .execute(conn)?;
            }
            Ok(())
        })
        .unwrap();
        // att-0 already belongs to another message.
        ATTACHMENT_SERVICE
            .link_to_message(&ids[..1], "msg-1", "thread-9")
            .await
            .unwrap();

        ATTACHMENT_SERVICE
            .link_to_message(&ids, "msg-9", "thread-9")
            .await
            .unwrap();

        assert_eq!(row("att-0").message_id.as_deref(), Some("msg-1"));
        assert_eq!(row("att-1").message_id.as_deref(), Some("msg-9"));
        assert_eq!(row("att-1").thread_id.as_deref(), Some("thread-9"));
        assert_eq!(row("att-99").message_id.as_deref(), Some("msg-9"));
        assert_eq!(row("att-100").message_id, None);

        let metas = ATTACHMENT_SERVICE
            .get_meta_by_message_ids(&["msg-9".to_string()])
            .await
            .unwrap();
        assert_eq!(metas["msg-9"].len(), 99);

        // An empty list is a no-op.
        ATTACHMENT_SERVICE
            .link_to_message(&[], "msg-9", "thread-9")
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_writes_each_blob_to_a_file_and_clears_the_column() {
        let _db = test_db();
        let g = DataDirGuard::new();
        legacy_row("a", Some(b"content of a"), None, 0);
        legacy_row("b", Some(b"content of b"), None, 0);

        let result = ATTACHMENT_SERVICE.backfill_blobs_to_files().await.unwrap();

        assert_eq!(
            result,
            BackfillResult {
                migrated: 2,
                failed: 0
            }
        );
        let a_row = row("a");
        assert_eq!(a_row.storage_path.as_deref(), Some("a-a.txt"));
        assert_eq!(a_row.data, None);
        assert_eq!(
            std::fs::read(g.media_dir().join("a-a.txt")).unwrap(),
            b"content of a"
        );

        // A migrated database matches nothing.
        let again = ATTACHMENT_SERVICE.backfill_blobs_to_files().await.unwrap();
        assert_eq!(again, BackfillResult::default());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn backfill_keeps_the_blob_and_continues_when_one_row_fails() {
        let _db = test_db();
        let g = DataDirGuard::new();
        legacy_row("a", Some(b"content of a"), None, 0);
        legacy_row("b", Some(b"content of b"), None, 0);
        // A directory where row a's file goes makes its write fail.
        std::fs::create_dir_all(g.media_dir().join("a-a.txt.tmp")).unwrap();

        let result = ATTACHMENT_SERVICE.backfill_blobs_to_files().await.unwrap();

        assert_eq!(
            result,
            BackfillResult {
                migrated: 1,
                failed: 1
            }
        );
        assert_eq!(row("a").data.as_deref(), Some(&b"content of a"[..]));
        assert_eq!(row("a").storage_path, None);
        assert_eq!(row("b").storage_path.as_deref(), Some("b-b.txt"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn expire_content_clears_both_columns_and_unlinks_the_file() {
        let _db = test_db();
        let g = DataDirGuard::new();
        let path = write_media_file("old-file", "a.png", b"x").await.unwrap();
        legacy_row("old-file", None, Some(&path), 10_000);
        legacy_row("old-blob", Some(b"blob"), None, 10_000);
        legacy_row("old-empty", None, None, 10_000);
        let young_path = write_media_file("young", "b.png", b"y").await.unwrap();
        legacy_row("young", None, Some(&young_path), 0);

        let expired = ATTACHMENT_SERVICE.expire_content(1000).await.unwrap();

        assert_eq!(expired, 2);
        for id in ["old-file", "old-blob"] {
            let r = row(id);
            assert_eq!((r.storage_path, r.data), (None, None));
        }
        assert!(!g.media_dir().join(&path).exists());
        assert!(g.media_dir().join(&young_path).exists());
        assert_eq!(row("young").storage_path, Some(young_path));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn marks_rows_with_neither_a_media_file_nor_a_blob_as_expired() {
        let _db = test_db();
        let _g = DataDirGuard::new();
        legacy_row("live", None, Some("live-a.png"), 3000);
        legacy_row("legacy", Some(b"blob"), None, 2000);
        legacy_row("gone", None, None, 1000);

        let metas = ATTACHMENT_SERVICE
            .get_meta_by_ids(&["live".into(), "legacy".into(), "gone".into()])
            .await
            .unwrap();

        let flags: Vec<(&str, bool)> = metas.iter().map(|m| (m.id.as_str(), m.expired)).collect();
        // A not-yet-backfilled BLOB row is not expired: its content still serves.
        assert_eq!(
            flags,
            vec![("live", false), ("legacy", false), ("gone", true)]
        );
        // storagePath itself is not serialized into the meta view.
        let json = serde_json::to_value(&metas[0]).unwrap();
        assert!(json.get("storagePath").is_none());
        assert_eq!(
            serde_json::to_string(&metas[0]).unwrap(),
            r#"{"id":"live","filename":"live.txt","mediaType":"text/plain","sizeBytes":3,"category":"text","expired":false}"#
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_orphans_reaps_old_unlinked_uploads_except_the_kept_ones() {
        let _db = test_db();
        let g = DataDirGuard::new();
        let stale = write_media_file("stale", "a.txt", b"x").await.unwrap();
        legacy_row("stale", None, Some(&stale), 10_000);
        let kept = write_media_file("kept", "b.txt", b"x").await.unwrap();
        legacy_row("kept", None, Some(&kept), 10_000);
        legacy_row("young", None, None, 0);

        let deleted = ATTACHMENT_SERVICE
            .delete_orphans(1000, &["kept".to_string()])
            .await
            .unwrap();

        assert_eq!(deleted, 1);
        assert!(!g.media_dir().join(&stale).exists());
        assert!(g.media_dir().join(&kept).exists());
        assert!(
            ATTACHMENT_SERVICE
                .get_by_id("kept")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            ATTACHMENT_SERVICE
                .get_by_id("young")
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            ATTACHMENT_SERVICE.delete_orphans(1000, &[]).await.unwrap(),
            1
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_unlinked_removes_the_row_and_its_file() {
        let _db = test_db();
        let g = DataDirGuard::new();
        let created = ATTACHMENT_SERVICE
            .create(input("pic.png", &[1]))
            .await
            .unwrap();
        let path = created.storage_path.clone().unwrap();

        assert_eq!(
            ATTACHMENT_SERVICE
                .delete_unlinked(&created.id)
                .await
                .unwrap(),
            1
        );
        assert!(!g.media_dir().join(&path).exists());
        assert_eq!(
            ATTACHMENT_SERVICE
                .delete_unlinked(&created.id)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconcile_nulls_storage_path_for_rows_whose_file_is_gone() {
        let _db = test_db();
        let _g = DataDirGuard::new();
        let ok = write_media_file("ok", "a.png", b"x").await.unwrap();
        legacy_row("ok", None, Some(&ok), 0);
        legacy_row("dangling", None, Some("dangling-b.pdf"), 0);

        assert_eq!(
            ATTACHMENT_SERVICE.reconcile_missing_files().await.unwrap(),
            1
        );
        assert_eq!(row("dangling").storage_path, None);
        assert_eq!(row("ok").storage_path, Some(ok));
        assert_eq!(
            ATTACHMENT_SERVICE.reconcile_missing_files().await.unwrap(),
            0
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reconcile_repoints_in_batches_so_a_whole_table_miss_cannot_overflow() {
        let _db = test_db();
        let _g = DataDirGuard::new();
        for i in 0..1200 {
            legacy_row(&format!("a{i}"), None, Some(&format!("a{i}.png")), 0);
        }
        assert_eq!(
            ATTACHMENT_SERVICE.reconcile_missing_files().await.unwrap(),
            1200
        );
        assert!(
            ATTACHMENT_SERVICE
                .list_live_storage_paths()
                .await
                .unwrap()
                .is_empty()
        );
    }
}
