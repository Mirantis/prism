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

use std::sync::LazyLock;

use async_trait::async_trait;
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::constants::{MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB};

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
    todo!()
}

/// The HTTP status of a failed read, when the error is a `TeamsHttpError`.
fn http_status(error: &anyhow::Error) -> Option<u16> {
    todo!()
}

/// A user-facing reason for a failed read, and the telemetry code for it.
fn failure_reason(read: &FileToRead, error: &anyhow::Error) -> (String, &'static str) {
    todo!()
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
    todo!()
}

/// Emits `teams attachment failed` with `attachment.kind` and `failure.reason`.
fn track_failure(read: &FileToRead, code: &str) {
    todo!()
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
