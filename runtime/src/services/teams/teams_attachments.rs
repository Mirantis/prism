//! Teams Attachments
//!
//! Reads the files on an inbound Teams message into stored attachments that the
//! turn links to the user's message. Each kind comes from a different place and
//! needs a different credential:
//!
//! - A file sent in a personal chat has a pre-authenticated OneDrive download
//!   URL (the manifest's `supportsFiles: true` lets people send one).
//! - A pasted image has a URL on the Bot Framework attachment service, read with
//!   the bot's token, or a Graph `hostedContents` URL, read with the app's Graph
//!   token (a channel message's hosted content is covered by
//!   `ChannelMessage.Read.Group`).
//! - A file shared in a channel lives in the team's SharePoint and is read
//!   through Graph, which needs a file permission an admin grants.
//!
//! A file that cannot be read becomes a failure the agent is told about; the
//! message is answered either way.

use std::collections::HashSet;
use std::sync::LazyLock;

use async_trait::async_trait;
use base64::Engine;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use url::Url;

use crate::config::CONFIG;
use crate::constants::{MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_info;
use crate::log_warn;
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, AttachmentSource, CreateAttachmentInput, classify_media_type,
    detect_media_type,
};
use crate::services::channel_adapter_interface::ChatPlatform;
use crate::services::teams::teams_adapter_service::TeamsHttpError;

/// One attachment of an inbound activity, as Teams sends it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsInboundAttachment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamsFileFailure {
    pub filename: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsInboundFiles {
    pub attachment_ids: Vec<String>,
    pub failures: Vec<TeamsFileFailure>,
    /// The name of every file found, read or not.
    pub names: Vec<String>,
}

/// A fetcher returns this when the response passes `MAX_FILE_SIZE_BYTES`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamsFileTooLargeError;

impl std::fmt::Display for TeamsFileTooLargeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "file exceeds {} MB", MAX_FILE_SIZE_MB)
    }
}

impl std::error::Error for TeamsFileTooLargeError {}

/// How a URL is read: the credential it is sent with.
///
/// A fetcher that gets a non-2xx response returns a
/// `teams_adapter_service::TeamsHttpError` with the status, since a 401/403
/// becomes a permission failure; a body past `MAX_FILE_SIZE_BYTES` returns
/// [`TeamsFileTooLargeError`].
#[async_trait]
pub trait TeamsFileFetchers: Send + Sync {
    /// GET with the bot's Bot Framework token.
    async fn bot(&self, url: &str) -> anyhow::Result<Vec<u8>>;
    /// GET with the app's Microsoft Graph token.
    async fn graph(&self, url: &str) -> anyhow::Result<Vec<u8>>;
    /// GET with no credential, for a pre-authenticated URL.
    async fn plain(&self, url: &str) -> anyhow::Result<Vec<u8>>;
}

/// Which fetcher reads a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Bot,
    Graph,
    Plain,
}

/// What a file is, for the `attachment.kind` telemetry prop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileKind {
    PersonalFile,
    InlineImage,
    ChannelFile,
}

impl FileKind {
    fn as_str(self) -> &'static str {
        match self {
            FileKind::PersonalFile => "personal_file",
            FileKind::InlineImage => "inline_image",
            FileKind::ChannelFile => "channel_file",
        }
    }
}

#[derive(Debug, Clone)]
struct FileToRead {
    kind: FileKind,
    filename: String,
    url: String,
    source: Source,
    declared_type: Option<String>,
}

/// The reads a message's attachments plan, and the attachments that cannot be read.
#[derive(Debug, Clone, Default)]
struct PlannedReads {
    reads: Vec<FileToRead>,
    failures: Vec<TeamsFileFailure>,
}

const FILE_DOWNLOAD_INFO: &str = "application/vnd.microsoft.teams.file.download.info";
const GRAPH_ORIGIN: &str = "https://graph.microsoft.com";

static IMG_SRC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<img\b[^>]*\bsrc="([^"]+)""#).expect("valid regex"));

/// Hosts that receive the bot's token: the Bot Framework attachment services.
fn is_bot_attachment_host(host: &str) -> bool {
    host == "smba.trafficmanager.net"
        || host.ends_with(".botframework.com")
        || host.ends_with(".asm.skype.com")
}

/// The URL when `raw` parses and is `https:`.
fn https_url(raw: Option<&str>) -> Option<Url> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "https").then_some(url)
}

/// Graph's `/shares` address for a SharePoint URL (`u!` + unpadded base64url).
fn graph_share_content_url(sharing_url: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sharing_url.as_bytes());
    format!("{GRAPH_ORIGIN}/v1.0/shares/u!{encoded}/driveItem/content")
}

/// Image URLs in a message's HTML body copy.
fn html_image_urls(html: &str) -> Vec<String> {
    IMG_SRC
        .captures_iter(html)
        .map(|c| c[1].replace("&amp;", "&"))
        .collect()
}

fn image_source(url: &Url) -> Option<Source> {
    if url.origin().ascii_serialization() == GRAPH_ORIGIN && url.path().contains("/hostedContents/")
    {
        return Some(Source::Graph);
    }
    if url.host_str().is_some_and(is_bot_attachment_host) {
        return Some(Source::Bot);
    }
    None
}

/// A host whose name ends with `.sharepoint.com`.
fn is_sharepoint(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| host.ends_with(".sharepoint.com"))
}

/// What each attachment is, and how to read it. Unknown kinds are left out.
///
/// Logs `[TeamsAttachments] inbound attachment` at info with `contentType` and
/// `host` for every attachment. A `file.download.info` attachment reads its
/// `content.downloadUrl` (a `*.sharepoint.com` https URL, else the failure
/// "Teams sent no download address for it"); a `reference` reads its SharePoint
/// `contentUrl` through Graph `/shares` (else "it is not stored in SharePoint,
/// where Prism reads files from"); an `image/*` attachment and each `<img>` of a
/// `text/html` body is an inline image, deduplicated by URL and named
/// `image-<n>` when unnamed.
fn plan_reads(attachments: &[TeamsInboundAttachment]) -> PlannedReads {
    let mut planned = PlannedReads::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut images = 0usize;

    let mut add_image = |planned: &mut PlannedReads,
                         raw: Option<&str>,
                         declared_type: Option<&str>,
                         name: Option<&str>| {
        let Some(url) = https_url(raw) else {
            return;
        };
        if seen.contains(url.as_str()) {
            return;
        }
        let Some(source) = image_source(&url) else {
            return;
        };
        seen.insert(url.as_str().to_string());
        images += 1;
        planned.reads.push(FileToRead {
            kind: FileKind::InlineImage,
            filename: name
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("image-{images}")),
            url: url.as_str().to_string(),
            source,
            declared_type: declared_type.map(str::to_string),
        });
    };

    for attachment in attachments {
        let content_type = attachment.content_type.as_deref().unwrap_or("");
        let mut fields = Map::new();
        fields.insert("contentType".to_string(), json!(content_type));
        if let Some(url) = https_url(attachment.content_url.as_deref()) {
            if let Some(host) = url.host_str() {
                fields.insert("host".to_string(), json!(host));
            }
        }
        log_info!(
            Value::Object(fields),
            "[TeamsAttachments] inbound attachment"
        );

        let name = attachment.name.as_deref().filter(|n| !n.is_empty());

        if content_type == FILE_DOWNLOAD_INFO {
            let filename = name.unwrap_or("file").to_string();
            let download_url = attachment
                .content
                .as_ref()
                .and_then(|c| c.get("downloadUrl"))
                .and_then(Value::as_str);
            let Some(download_url) = https_url(download_url).filter(is_sharepoint) else {
                planned.failures.push(TeamsFileFailure {
                    filename,
                    reason: "Teams sent no download address for it".to_string(),
                });
                continue;
            };
            planned.reads.push(FileToRead {
                kind: FileKind::PersonalFile,
                filename,
                url: download_url.as_str().to_string(),
                source: Source::Plain,
                declared_type: None,
            });
            continue;
        }

        if content_type == "reference" {
            let filename = name.unwrap_or("file").to_string();
            let Some(sharing_url) =
                https_url(attachment.content_url.as_deref()).filter(is_sharepoint)
            else {
                planned.failures.push(TeamsFileFailure {
                    filename,
                    reason: "it is not stored in SharePoint, where Prism reads files from"
                        .to_string(),
                });
                continue;
            };
            planned.reads.push(FileToRead {
                kind: FileKind::ChannelFile,
                filename,
                url: graph_share_content_url(sharing_url.as_str()),
                source: Source::Graph,
                declared_type: None,
            });
            continue;
        }

        if content_type.starts_with("image/") {
            add_image(
                &mut planned,
                attachment.content_url.as_deref(),
                Some(content_type),
                attachment.name.as_deref(),
            );
            continue;
        }

        if content_type == "text/html" {
            if let Some(Value::String(html)) = &attachment.content {
                for src in html_image_urls(html) {
                    add_image(&mut planned, Some(&src), None, None);
                }
            }
        }
    }

    planned
}

/// The HTTP status of a failed read, when the error is a `TeamsHttpError`.
fn http_status(error: &anyhow::Error) -> Option<u16> {
    error.downcast_ref::<TeamsHttpError>().map(|e| e.status)
}

/// A user-facing reason for a failed read, and the telemetry code for it.
fn failure_reason(read: &FileToRead, error: &anyhow::Error) -> (String, &'static str) {
    let status = http_status(error);
    if matches!(status, Some(401 | 403)) {
        return if read.kind == FileKind::ChannelFile {
            (
                "Prism has no permission to read files in this team's SharePoint. A Microsoft 365 admin \
                 can grant it the Files.Read.All application permission"
                    .to_string(),
                "permission",
            )
        } else {
            ("Teams refused Prism access to it".to_string(), "permission")
        };
    }
    if error.downcast_ref::<TeamsFileTooLargeError>().is_some() {
        return (
            format!("it exceeds the {MAX_FILE_SIZE_MB} MB limit"),
            "too_large",
        );
    }
    let reason = match status {
        Some(status) if status != 0 => format!("the download failed with HTTP {status}"),
        _ => "the download failed".to_string(),
    };
    (reason, "error")
}

/// Read and store every file on the message. Owns `teams attachment failed`;
/// a stored file is counted by `attachment uploaded`, which the attachment
/// service emits.
///
/// Reads past `MAX_ATTACHMENTS_PER_MESSAGE` become one failure named
/// `<n> more file(s)`. An empty download, a download past `MAX_FILE_SIZE_BYTES`
/// and any fetch or store error become failures; nothing is returned as an error.
pub async fn read_inbound_files(
    attachments: Option<&[TeamsInboundAttachment]>,
    fetchers: &dyn TeamsFileFetchers,
    thread_id: Option<&str>,
) -> TeamsInboundFiles {
    let planned = plan_reads(attachments.unwrap_or_default());
    let mut failures = planned.failures.clone();
    let names: Vec<String> = planned
        .reads
        .iter()
        .map(|r| r.filename.clone())
        .chain(planned.failures.iter().map(|f| f.filename.clone()))
        .collect();
    let mut attachment_ids: Vec<String> = Vec::new();

    let mut reads = planned.reads;
    if reads.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        failures.push(TeamsFileFailure {
            filename: format!("{} more file(s)", reads.len() - MAX_ATTACHMENTS_PER_MESSAGE),
            reason: format!(
                "only the first {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message are kept"
            ),
        });
        reads.truncate(MAX_ATTACHMENTS_PER_MESSAGE);
    }

    for read in &reads {
        match read_one(read, fetchers, thread_id).await {
            Ok(Ok(id)) => attachment_ids.push(id),
            Ok(Err((reason, code))) => {
                failures.push(TeamsFileFailure {
                    filename: read.filename.clone(),
                    reason,
                });
                track_failure(read, code);
            }
            Err(error) => {
                let (reason, code) = failure_reason(read, &error);
                log_warn!(
                    json!({ "err": err_json(&error), "kind": read.kind.as_str() }),
                    "[TeamsAttachments] could not read an inbound file"
                );
                failures.push(TeamsFileFailure {
                    filename: read.filename.clone(),
                    reason,
                });
                track_failure(read, code);
            }
        }
    }

    TeamsInboundFiles {
        attachment_ids,
        failures,
        names,
    }
}

/// Reads and stores one file: its attachment id, or the reason and telemetry
/// code of a download that came back unusable. A fetch or store error is the `Err`.
async fn read_one(
    read: &FileToRead,
    fetchers: &dyn TeamsFileFetchers,
    thread_id: Option<&str>,
) -> anyhow::Result<Result<String, (String, &'static str)>> {
    let bytes = match read.source {
        Source::Bot => fetchers.bot(&read.url).await?,
        Source::Graph => fetchers.graph(&read.url).await?,
        Source::Plain => fetchers.plain(&read.url).await?,
    };
    if bytes.is_empty() {
        return Ok(Err(("it downloaded as an empty file".to_string(), "empty")));
    }
    if bytes.len() as i64 > MAX_FILE_SIZE_BYTES {
        return Ok(Err((
            format!("it exceeds the {MAX_FILE_SIZE_MB} MB limit"),
            "too_large",
        )));
    }
    let media_type = detect_media_type(&bytes, &read.filename, read.declared_type.as_deref());
    let row = ATTACHMENT_SERVICE
        .create(CreateAttachmentInput {
            filename: read.filename.clone(),
            category: classify_media_type(&media_type),
            media_type,
            size_bytes: bytes.len() as i64,
            data: bytes,
            source: AttachmentSource::Platform(ChatPlatform::Teams),
            thread_id: thread_id.map(str::to_string),
            message_id: None,
            external_file_id: None,
            external_ts: None,
        })
        .await?;
    Ok(Ok(row.id))
}

/// Emits `teams attachment failed` with `attachment.kind` and `failure.reason`.
fn track_failure(read: &FileToRead, code: &str) {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props.insert(
        "attachment.kind".to_string(),
        read.kind.as_str().to_string(),
    );
    props.insert("failure.reason".to_string(), code.to_string());
    track_event("teams attachment failed", None, Some(props));
}

/// The runtime notice for files that could not be read. Worded so the agent
/// tells the user, rather than claim nothing was attached or look for the file
/// on disk.
pub fn build_file_failure_notice(failures: &[TeamsFileFailure]) -> String {
    let list = failures
        .iter()
        .map(|f| format!("\"{}\": {}", f.filename, f.reason))
        .collect::<Vec<_>>()
        .join("; ");
    let many = failures.len() > 1;
    format!(
        "The user attached {} to this Microsoft Teams message that Prism could not read, so you do NOT have {} contents: {}. In your reply, tell the user you couldn't read {} and give the reason. Do not say no file was attached, and do not ask for a file path or look on disk.",
        if many { "files" } else { "a file" },
        if many { "their" } else { "its" },
        list,
        if many {
            "their attached files"
        } else {
            "their attached file"
        },
    )
}

/// The message text when a message carries files and no words.
pub fn describe_shared_files(names: &[String]) -> String {
    if names.len() > 1 {
        format!("(shared files: {})", names.join(", "))
    } else {
        format!(
            "(shared a file: {})",
            names.first().map(String::as_str).unwrap_or("undefined")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::MessageAttachment;
    use crate::db::schema::message_attachments as ma;
    use crate::db::testing::test_db;
    use crate::lib::media_store::tests::DataDirGuard;
    use diesel::prelude::*;
    use parking_lot::Mutex;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
    ];

    /// What a fetcher answers.
    #[derive(Clone)]
    enum Answer {
        Bytes(Vec<u8>),
        Status(u16),
        TooLarge,
        Fails,
    }

    /// Fetchers that record each call and answer from a queue, else with `default`.
    struct FakeFetchers {
        default: Vec<u8>,
        queued: Mutex<Vec<(&'static str, Answer)>>,
        calls: Mutex<Vec<(&'static str, String)>>,
    }

    impl FakeFetchers {
        fn new(default: &[u8]) -> Self {
            FakeFetchers {
                default: default.to_vec(),
                queued: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn answer(self, source: &'static str, answer: Answer) -> Self {
            self.queued.lock().push((source, answer));
            self
        }

        fn calls(&self, source: &str) -> Vec<String> {
            self.calls
                .lock()
                .iter()
                .filter(|(s, _)| *s == source)
                .map(|(_, url)| url.clone())
                .collect()
        }

        fn fetch(&self, source: &'static str, url: &str) -> anyhow::Result<Vec<u8>> {
            self.calls.lock().push((source, url.to_string()));
            let answer = {
                let mut queued = self.queued.lock();
                match queued.iter().position(|(s, _)| *s == source) {
                    Some(index) => queued.remove(index).1,
                    None => Answer::Bytes(self.default.clone()),
                }
            };
            match answer {
                Answer::Bytes(bytes) => Ok(bytes),
                Answer::Status(status) => Err(TeamsHttpError::sdk(status, None).into()),
                Answer::TooLarge => Err(TeamsFileTooLargeError.into()),
                Answer::Fails => Err(anyhow::anyhow!("boom")),
            }
        }
    }

    #[async_trait]
    impl TeamsFileFetchers for FakeFetchers {
        async fn bot(&self, url: &str) -> anyhow::Result<Vec<u8>> {
            self.fetch("bot", url)
        }
        async fn graph(&self, url: &str) -> anyhow::Result<Vec<u8>> {
            self.fetch("graph", url)
        }
        async fn plain(&self, url: &str) -> anyhow::Result<Vec<u8>> {
            self.fetch("plain", url)
        }
    }

    fn personal_file() -> TeamsInboundAttachment {
        TeamsInboundAttachment {
            content_type: Some(FILE_DOWNLOAD_INFO.to_string()),
            content_url: Some(
                "https://contoso-my.sharepoint.com/personal/jane/Documents/Applications/report.txt"
                    .to_string(),
            ),
            name: Some("report.txt".to_string()),
            content: Some(json!({
                "downloadUrl": "https://contoso-my.sharepoint.com/download?token=abc",
                "fileType": "txt",
            })),
        }
    }

    const CHANNEL_FILE_URL: &str =
        "https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General/plan.docx";

    fn channel_file() -> TeamsInboundAttachment {
        TeamsInboundAttachment {
            content_type: Some("reference".to_string()),
            content_url: Some(CHANNEL_FILE_URL.to_string()),
            name: Some("plan.docx".to_string()),
            content: None,
        }
    }

    fn image(url: &str) -> TeamsInboundAttachment {
        TeamsInboundAttachment {
            content_type: Some("image/*".to_string()),
            content_url: Some(url.to_string()),
            ..Default::default()
        }
    }

    fn html(content: &str) -> TeamsInboundAttachment {
        TeamsInboundAttachment {
            content_type: Some("text/html".to_string()),
            content: Some(json!(content)),
            ..Default::default()
        }
    }

    async fn stored() -> Vec<MessageAttachment> {
        crate::db::run(|conn| {
            Ok(ma::table
                .select(MessageAttachment::as_select())
                .load(conn)?)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_a_personal_chat_file_from_its_download_url_with_no_credential() {
        let _db = test_db();
        let _dir = DataDirGuard::new();
        let f = FakeFetchers::new(b"hello");

        let result = read_inbound_files(Some(&[personal_file()]), &f, None).await;

        assert_eq!(
            f.calls("plain"),
            vec!["https://contoso-my.sharepoint.com/download?token=abc"]
        );
        assert!(f.calls("bot").is_empty());
        assert!(f.calls("graph").is_empty());
        let rows = stored().await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].filename, "report.txt");
        assert_eq!(rows[0].source, "teams");
        assert_eq!(rows[0].size_bytes, 5);
        assert_eq!(
            result,
            TeamsInboundFiles {
                attachment_ids: vec![rows[0].id.clone()],
                failures: vec![],
                names: vec!["report.txt".to_string()],
            }
        );
    }

    #[tokio::test]
    async fn refuses_a_download_url_outside_sharepoint() {
        let f = FakeFetchers::new(PNG);
        let mut file = personal_file();
        file.content = Some(json!({ "downloadUrl": "https://attacker.example/x" }));

        let result = read_inbound_files(Some(&[file]), &f, None).await;

        assert!(f.calls("plain").is_empty());
        assert_eq!(
            result.failures,
            vec![TeamsFileFailure {
                filename: "report.txt".to_string(),
                reason: "Teams sent no download address for it".to_string(),
            }]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_a_pasted_image_from_the_bot_framework_attachment_service_with_the_bot_token() {
        let _db = test_db();
        let _dir = DataDirGuard::new();
        let f = FakeFetchers::new(PNG);
        let url = "https://smba.trafficmanager.net/emea/v3/attachments/0-weu-d1/views/original";

        let result = read_inbound_files(Some(&[image(url)]), &f, None).await;

        assert_eq!(f.calls("bot"), vec![url]);
        let rows = stored().await;
        assert_eq!(rows[0].filename, "image-1");
        assert_eq!(rows[0].media_type, "image/png");
        assert_eq!(rows[0].category, "image");
        assert_eq!(result.attachment_ids, vec![rows[0].id.clone()]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_a_hosted_image_from_the_html_body_with_the_graph_token_once_per_url() {
        let _db = test_db();
        let _dir = DataDirGuard::new();
        let f = FakeFetchers::new(PNG);
        let src = "https://graph.microsoft.com/v1.0/teams/t1/channels/c1/messages/m1/hostedContents/h1/$value";

        read_inbound_files(
            Some(&[
                image(src),
                html(&format!(
                    "<p>look</p><img alt=\"x\" src=\"{src}\" itemtype=\"img\">"
                )),
            ]),
            &f,
            None,
        )
        .await;

        assert_eq!(f.calls("graph"), vec![src]);
        assert!(f.calls("bot").is_empty());
    }

    #[tokio::test]
    async fn sends_no_credential_to_an_image_on_any_other_host() {
        let f = FakeFetchers::new(PNG);

        let result = read_inbound_files(
            Some(&[
                TeamsInboundAttachment {
                    content_type: Some("image/png".to_string()),
                    content_url: Some("https://attacker.example/i.png".to_string()),
                    ..Default::default()
                },
                html("<img src=\"https://graph.microsoft.com/v1.0/me/photo/$value\">"),
            ]),
            &f,
            None,
        )
        .await;

        assert!(f.calls("bot").is_empty());
        assert!(f.calls("graph").is_empty());
        assert_eq!(result, TeamsInboundFiles::default());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_a_channel_file_through_the_graph_shares_api() {
        let _db = test_db();
        let _dir = DataDirGuard::new();
        let f = FakeFetchers::new(b"doc");

        read_inbound_files(Some(&[channel_file()]), &f, None).await;

        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(CHANNEL_FILE_URL.as_bytes());
        assert_eq!(
            f.calls("graph"),
            vec![format!(
                "https://graph.microsoft.com/v1.0/shares/u!{encoded}/driveItem/content"
            )]
        );
    }

    #[tokio::test]
    async fn turns_a_refused_channel_file_read_into_a_failure_that_names_the_admin_permission() {
        let f = FakeFetchers::new(PNG).answer("graph", Answer::Status(403));

        let result = read_inbound_files(Some(&[channel_file()]), &f, None).await;

        assert!(result.attachment_ids.is_empty());
        assert_eq!(result.names, vec!["plan.docx"]);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].filename, "plan.docx");
        assert!(result.failures[0].reason.contains("Files.Read.All"));
    }

    #[test]
    fn names_the_permission_and_too_large_and_status_failures() {
        let read = FileToRead {
            kind: FileKind::InlineImage,
            filename: "image-1".to_string(),
            url: "https://smba.trafficmanager.net/a".to_string(),
            source: Source::Bot,
            declared_type: None,
        };
        let status = |s| anyhow::Error::from(TeamsHttpError::plain(s));
        assert_eq!(
            failure_reason(&read, &status(401)),
            ("Teams refused Prism access to it".to_string(), "permission")
        );
        assert_eq!(
            failure_reason(&read, &anyhow::Error::from(TeamsFileTooLargeError)),
            ("it exceeds the 10 MB limit".to_string(), "too_large")
        );
        assert_eq!(
            failure_reason(&read, &status(500)),
            ("the download failed with HTTP 500".to_string(), "error")
        );
        assert_eq!(
            failure_reason(&read, &anyhow::anyhow!("boom")),
            ("the download failed".to_string(), "error")
        );
    }

    #[tokio::test]
    async fn reports_an_oversized_and_an_empty_download_as_failures() {
        let f = FakeFetchers::new(PNG)
            .answer("plain", Answer::TooLarge)
            .answer("bot", Answer::Bytes(Vec::new()));

        let result = read_inbound_files(
            Some(&[
                personal_file(),
                image("https://smba.trafficmanager.net/emea/v3/attachments/a"),
            ]),
            &f,
            None,
        )
        .await;

        assert_eq!(
            result.failures,
            vec![
                TeamsFileFailure {
                    filename: "report.txt".to_string(),
                    reason: "it exceeds the 10 MB limit".to_string(),
                },
                TeamsFileFailure {
                    filename: "image-1".to_string(),
                    reason: "it downloaded as an empty file".to_string(),
                },
            ]
        );
        assert!(result.attachment_ids.is_empty());
    }

    #[tokio::test]
    async fn keeps_reading_after_a_failed_download() {
        let f = FakeFetchers::new(PNG).answer("graph", Answer::Fails);

        let result = read_inbound_files(Some(&[channel_file()]), &f, None).await;

        assert_eq!(
            result.failures,
            vec![TeamsFileFailure {
                filename: "plan.docx".to_string(),
                reason: "the download failed".to_string(),
            }]
        );
    }

    #[test]
    fn tells_the_agent_what_failed_and_not_to_claim_nothing_was_attached() {
        let notice = build_file_failure_notice(&[TeamsFileFailure {
            filename: "plan.docx".to_string(),
            reason: "no permission".to_string(),
        }]);

        assert!(notice.contains("\"plan.docx\": no permission"));
        assert!(notice.contains("Do not say no file was attached"));
    }

    #[test]
    fn names_one_shared_file_or_several() {
        assert_eq!(
            describe_shared_files(&["a.txt".to_string()]),
            "(shared a file: a.txt)"
        );
        assert_eq!(
            describe_shared_files(&["a.txt".to_string(), "b.png".to_string()]),
            "(shared files: a.txt, b.png)"
        );
    }
}
