//! web_fetch: read a public web page as text.
//!
//! One GET from the runtime process, with no JavaScript, no cookies and no sign-in.
//! HTML becomes markdown (`lib::html_to_markdown`); markdown, plain text, JSON and
//! XML are returned as they are. The result is plain text, so the generic tool-output
//! limit cuts a long result and saves all of it for the shell to read. A body over
//! `MAX_BODY_BYTES` is cut first, and the result says so.
//!
//! Every host, the first and each redirect target, goes through `lib::public_url`.
//! A failed read names the next step, which for a page that needs a sign-in or
//! JavaScript is the browser.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::ai::errors::ABORTED_MESSAGE;
use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::lib::html_to_markdown::{MarkdownExtractor, html_to_markdown};
use crate::lib::public_url::{PrivateAddressError, PublicResolver, assert_public_literal};
use crate::lib::telemetry::track_event;
use crate::support::js::{is_js_whitespace, number_text, trim as js_trim};

pub const WEB_FETCH_TOOL_NAME: &str = "web_fetch";
pub const ACCEPT: &str =
    "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1";
pub const SOURCE_NOTE: &str = "The text below comes from this page, not from your user.";
pub const WEB_FETCH_DESCRIPTION: &str = "Read a public web page as text: its main text as markdown, with its title and final address. Use it to read a page instead of opening it in the browser. It runs no JavaScript and sends no sign-in, so open a page that needs either in the browser.";

pub const WEB_FETCH_TIMEOUT_MS: u64 = 20_000;
pub const MAX_BODY_MB: usize = 5;
pub const MAX_BODY_BYTES: usize = MAX_BODY_MB * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;

/// Fewer visible characters than this, on a page that loads scripts, may be all the
/// page shows before its scripts run, so the read adds a hint to open the browser.
pub const MIN_TEXT_CHARS: usize = 100;

/// `Mozilla/5.0 (compatible; Prism-Agent/<app version>)`, without the
/// `/<version>` when the build has none.
pub static USER_AGENT: LazyLock<String> =
    LazyLock::new(|| user_agent_for(&crate::config::CONFIG.app_version));

/// `Mozilla/5.0 (compatible; Prism-Agent/<version>)` for a version, or without
/// it when the version is empty.
pub fn user_agent_for(app_version: &str) -> String {
    if app_version.is_empty() {
        "Mozilla/5.0 (compatible; Prism-Agent)".to_string()
    } else {
        format!("Mozilla/5.0 (compatible; Prism-Agent/{app_version})")
    }
}

/// The client of a read: each connection resolves its host with the public-address
/// lookup, and it follows no redirect and decompresses nothing, since the read
/// handles both itself. Direct even when HTTPS_PROXY is set: a proxy would resolve
/// the name itself, and only a connection that resolves it with the public lookup
/// reaches a checked address. The read sends no credential for a proxy to rewrite.
static WEB_FETCH_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(PublicResolver))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .expect("the web_fetch client builds")
});

#[derive(Debug, Clone, Deserialize)]
pub struct WebFetchInput {
    /// The http or https address of the page.
    pub url: String,
}

pub fn web_fetch_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The http or https address of the page."
            }
        },
        "required": ["url"],
        "additionalProperties": false
    })
}

/// How a read ended, as `fetch.outcome` records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    InvalidUrl,
    BlockedAddress,
    HttpError,
    RedirectLimit,
    Timeout,
    UnsupportedType,
    NoText,
    NetworkError,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::InvalidUrl => "invalid_url",
            Outcome::BlockedAddress => "blocked_address",
            Outcome::HttpError => "http_error",
            Outcome::RedirectLimit => "redirect_limit",
            Outcome::Timeout => "timeout",
            Outcome::UnsupportedType => "unsupported_type",
            Outcome::NoText => "no_text",
            Outcome::NetworkError => "network_error",
            Outcome::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentKind {
    Html,
    Markdown,
    Text,
    Json,
    Xml,
    Other,
}

impl ContentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentKind::Html => "html",
            ContentKind::Markdown => "markdown",
            ContentKind::Text => "text",
            ContentKind::Json => "json",
            ContentKind::Xml => "xml",
            ContentKind::Other => "other",
        }
    }
}

/// Which extractor turned an HTML page into text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Extractor {
    Readability,
    WholePage,
}

impl Extractor {
    fn as_str(self) -> &'static str {
        match self {
            Extractor::Readability => "readability",
            Extractor::WholePage => "whole_page",
        }
    }
}

impl From<MarkdownExtractor> for Extractor {
    fn from(extractor: MarkdownExtractor) -> Self {
        match extractor {
            MarkdownExtractor::Readability => Extractor::Readability,
            MarkdownExtractor::WholePage => Extractor::WholePage,
        }
    }
}

/// One read: the text for the model, and what telemetry records about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub outcome: Outcome,
    pub text: String,
    pub http_status: Option<u16>,
    pub content_kind: Option<ContentKind>,
    pub extractor: Option<Extractor>,
    pub redirects: usize,
    pub bytes: usize,
    pub capped: bool,
}

impl Read {
    fn new() -> Read {
        Read {
            outcome: Outcome::Ok,
            text: String::new(),
            http_status: None,
            content_kind: None,
            extractor: None,
            redirects: 0,
            bytes: 0,
            capped: false,
        }
    }

    /// This read, ended with `outcome` and the text the model reads.
    fn fail(&self, outcome: Outcome, text: String) -> Read {
        Read {
            outcome,
            text,
            ..self.clone()
        }
    }
}

/// Checks that a host is a public address; fails with the private-address error.
pub type AssertHost = Arc<dyn Fn(&str) -> anyhow::Result<()> + Send + Sync>;

#[derive(Clone, Default)]
pub struct WebFetchDeps {
    /// The turn's signal, so a cancelled turn stops the read.
    pub abort_signal: Option<CancellationToken>,
    /// Overridable for tests, which serve pages from a loopback address.
    pub assert_host: Option<AssertHost>,
    /// The client that resolves names through the public-address lookup.
    pub client: Option<reqwest::Client>,
    pub timeout_ms: Option<u64>,
}

/// Read one page and record the outcome, one `web page fetched` event per call.
/// Never fails, except for a cancelled turn, which is recorded as `cancelled`
/// first.
pub async fn run_web_fetch(
    input: WebFetchInput,
    user_id: &str,
    agent_id: &str,
    deps: WebFetchDeps,
) -> anyhow::Result<String> {
    let started_at = crate::support::now_ms();
    match read_page(&input.url, &deps).await {
        Ok(read) => {
            record(user_id, agent_id, &read, started_at);
            Ok(read.text)
        }
        Err(err) => {
            record(
                user_id,
                agent_id,
                &Read::new().fail(Outcome::Cancelled, String::new()),
                started_at,
            );
            Err(err)
        }
    }
}

/// The `web page fetched` event for one read.
fn record(user_id: &str, agent_id: &str, read: &Read, started_at: i64) {
    let mut props = IndexMap::new();
    props.insert("agent.id".to_string(), agent_id.to_string());
    props.insert(
        "fetch.outcome".to_string(),
        read.outcome.as_str().to_string(),
    );
    if let Some(status) = read.http_status.filter(|s| *s != 0) {
        props.insert("fetch.http_status".to_string(), status.to_string());
    }
    if let Some(kind) = read.content_kind {
        props.insert("fetch.content_kind".to_string(), kind.as_str().to_string());
    }
    if let Some(extractor) = read.extractor {
        props.insert(
            "fetch.extractor".to_string(),
            extractor.as_str().to_string(),
        );
    }
    props.insert("fetch.redirects".to_string(), read.redirects.to_string());
    props.insert("fetch.bytes".to_string(), read.bytes.to_string());
    props.insert("fetch.capped".to_string(), read.capped.to_string());
    props.insert(
        "fetch.duration_ms".to_string(),
        (crate::support::now_ms() - started_at).to_string(),
    );
    track_event("web page fetched", Some(user_id), Some(props));
}

/// The body of a page, and what the read needs to render it.
struct Fetched {
    url: Url,
    content_type: String,
    kind: ContentKind,
    bytes: Vec<u8>,
    capped: bool,
}

/// How the request part of a read ended.
enum Step {
    Done(Read),
    Body(Fetched),
}

/// GET the page, following up to `MAX_REDIRECTS` redirects with each host
/// checked, with `accept: ACCEPT`, `accept-encoding: identity` and the user agent.
/// Direct even when HTTPS_PROXY is set: a proxy would resolve the name itself, and
/// only a connection that resolves it with the public lookup reaches a checked
/// address.
async fn read_page(address: &str, deps: &WebFetchDeps) -> anyhow::Result<Read> {
    let mut read = Read::new();

    let Ok(mut url) = Url::parse(address) else {
        return Ok(read.fail(
            Outcome::InvalidUrl,
            format!("{address} is not a web address. Give an http or https address."),
        ));
    };

    let timeout_ms = deps.timeout_ms.unwrap_or(WEB_FETCH_TIMEOUT_MS);
    let never = CancellationToken::new();
    let abort = deps.abort_signal.clone().unwrap_or(never);
    let step = {
        let request = request_page(address, deps, &mut read, &mut url);
        tokio::select! {
            result = tokio::time::timeout(Duration::from_millis(timeout_ms), request) => match result {
                Ok(step) => step,
                Err(_) => Err(TimedOut.into()),
            },
            () = abort.cancelled() => anyhow::bail!(ABORTED_MESSAGE),
        }
    };
    let fetched = match step {
        Ok(Step::Done(done)) => return Ok(done),
        Ok(Step::Body(fetched)) => fetched,
        Err(err) if err.is::<TimedOut>() => {
            let seconds = number_text(timeout_ms as f64 / 1000.0);
            return Ok(read.fail(
                Outcome::Timeout,
                format!("{} did not answer within {seconds} seconds.", url.as_str()),
            ));
        }
        Err(err) => return Ok(failure(&err, &url, &read)),
    };

    read.bytes = fetched.bytes.len();
    read.capped = fetched.capped;
    match render(
        fetched.url.as_str(),
        &fetched.content_type,
        fetched.kind,
        fetched.bytes,
        fetched.capped,
    )
    .await
    {
        Ok((outcome, text, extractor)) => Ok(Read {
            outcome,
            text,
            extractor,
            ..read
        }),
        Err(err) => Ok(failure(&err, &fetched.url, &read)),
    }
}

/// The read hit its deadline.
#[derive(Debug, thiserror::Error)]
#[error("timed out")]
struct TimedOut;

async fn request_page(
    address: &str,
    deps: &WebFetchDeps,
    read: &mut Read,
    url: &mut Url,
) -> anyhow::Result<Step> {
    let client = deps
        .client
        .clone()
        .unwrap_or_else(|| WEB_FETCH_CLIENT.clone());
    loop {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Ok(Step::Done(read.fail(
                Outcome::InvalidUrl,
                format!(
                    "web_fetch reads http and https addresses, and {} is {}.",
                    url.as_str(),
                    url.scheme()
                ),
            )));
        }
        let hostname = url.host_str().unwrap_or("").to_string();
        match &deps.assert_host {
            Some(assert) => assert(&hostname)?,
            None => assert_public_literal(&hostname)?,
        }
        let response = client
            .get(url.clone())
            // The read decompresses nothing, and with no Accept-Encoding a server may
            // choose any coding, so the read asks for the body as it is.
            .header("accept", ACCEPT)
            .header("accept-encoding", "identity")
            .header("user-agent", USER_AGENT.as_str())
            .send()
            .await?;
        let status = response.status().as_u16();
        read.http_status = Some(status);

        let location = header(&response, "location");
        if (300..400).contains(&status) && location.is_some() {
            drop(response);
            if read.redirects == MAX_REDIRECTS {
                return Ok(Step::Done(read.fail(
                    Outcome::RedirectLimit,
                    format!(
                        "{address} redirected more than {MAX_REDIRECTS} times, so web_fetch stopped."
                    ),
                )));
            }
            read.redirects += 1;
            read.http_status = None;
            *url = url
                .join(location.as_deref().unwrap_or(""))
                .map_err(|_| anyhow::anyhow!("Invalid URL"))?;
            continue;
        }
        if !(200..300).contains(&status) {
            let cf_mitigated = header(&response, "cf-mitigated");
            drop(response);
            return Ok(Step::Done(read.fail(
                Outcome::HttpError,
                http_error_text(url, status, cf_mitigated.as_deref()),
            )));
        }

        let content_type = header(&response, "content-type").unwrap_or_default();
        let kind = content_kind(&content_type);
        read.content_kind = Some(kind);
        if kind == ContentKind::Other {
            drop(response);
            let media = content_type.split(';').next().unwrap_or("");
            let media = if media.is_empty() {
                "a file with no content type"
            } else {
                media
            };
            return Ok(Step::Done(read.fail(
                Outcome::UnsupportedType,
                format!(
                    "web_fetch reads text pages, and {} is {media}. Download it with the shell instead.",
                    url.as_str()
                ),
            )));
        }

        let (bytes, capped) = read_body(response).await?;
        return Ok(Step::Body(Fetched {
            url: url.clone(),
            content_type,
            kind,
            bytes,
            capped,
        }));
    }
}

/// A response header's first value, its bytes read as Latin-1.
fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .map(|value| value.as_bytes().iter().map(|&b| b as char).collect())
}

/// Up to `MAX_BODY_BYTES` of the body. A larger body is cut there, and `capped`
/// says so; the rest is not read.
async fn read_body(mut response: reqwest::Response) -> anyhow::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let remaining = MAX_BODY_BYTES - bytes.len();
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

/// The text for an error from the address check, the resolver or the connection.
fn failure(err: &anyhow::Error, url: &Url, read: &Read) -> Read {
    let private = err
        .chain()
        .find_map(|cause| cause.downcast_ref::<PrivateAddressError>().cloned());
    if let Some(PrivateAddressError { hostname, address }) = private {
        let subject = if hostname == address {
            address
        } else {
            format!("{hostname} resolves to {address}, which")
        };
        return read.fail(
            Outcome::BlockedAddress,
            format!(
                "web_fetch reads public addresses only, and {subject} is not public. Use the browser or the shell for a page on a private network."
            ),
        );
    }
    let innermost = innermost_message(err);
    if innermost.contains("failed to lookup address") {
        return read.fail(
            Outcome::NetworkError,
            format!(
                "{} does not resolve to an address.",
                url.host_str().unwrap_or("")
            ),
        );
    }
    read.fail(
        Outcome::NetworkError,
        format!("web_fetch could not read {}: {innermost}", url.as_str()),
    )
}

/// The message of the deepest cause, which names what went wrong on the wire.
fn innermost_message(err: &anyhow::Error) -> String {
    err.chain()
        .last()
        .map_or_else(|| err.to_string(), |cause| cause.to_string())
}

/// The text for a failed HTTP status: a sign-in or a block for 401, 403, 429 and a
/// `cf-mitigated: challenge`; `does not exist` for 404 and 410; else the status.
fn http_error_text(url: &url::Url, status: u16, cf_mitigated: Option<&str>) -> String {
    if status == 401 || status == 403 || status == 429 || cf_mitigated == Some("challenge") {
        return format!(
            "{} refused the request (HTTP {status}). The page may need a sign-in, or the site blocks automated readers. Open it in the browser.",
            url_host(url)
        );
    }
    if status == 404 || status == 410 {
        return format!("{} does not exist (HTTP {status}).", url.as_str());
    }
    format!(
        "{} answered HTTP {status} for {}.",
        url_host(url),
        url.as_str()
    )
}

/// `URL.host`: the host with its port when the URL names a non-default one.
fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

pub fn content_kind(content_type: &str) -> ContentKind {
    let kind = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if kind == "text/html" || kind == "application/xhtml+xml" {
        return ContentKind::Html;
    }
    if kind == "text/markdown" || kind == "text/x-markdown" {
        return ContentKind::Markdown;
    }
    if kind == "application/json" || kind.ends_with("+json") {
        return ContentKind::Json;
    }
    if kind == "application/xml" || kind == "text/xml" || kind.ends_with("+xml") {
        return ContentKind::Xml;
    }
    if kind.starts_with("text/") {
        return ContentKind::Text;
    }
    ContentKind::Other
}

/// The encoding a byte order mark names. As in a browser, it outranks every
/// declared charset.
pub fn bom_encoding(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Some("utf-8");
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return Some("utf-16be");
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return Some("utf-16le");
    }
    None
}

static XML_ENCODING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^<\?xml(?-u:\b)[^>]*(?-u:\b)encoding[\t\n\x0B\x0C\r \u{a0}]*=[\t\n\x0B\x0C\r \u{a0}]*["']([A-Za-z0-9_.:-]+)"#)
        .unwrap()
});
static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|\z)").unwrap());
static META_CHARSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<meta(?-u:\b)[^>]*?[\t\n\x0B\x0C\r \u{a0};"']charset[\t\n\x0B\x0C\r \u{a0}]*=[\t\n\x0B\x0C\r \u{a0}]*["']?([A-Za-z0-9_.:-]+)"#)
        .unwrap()
});
static TYPE_CHARSET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)charset=["']?([A-Za-z0-9_.:-]+)"#).unwrap());

/// The charset a document names in its first 1024 bytes: the encoding of an XML
/// declaration, which XHTML and RSS use, else an HTML page's meta charset. A
/// comment can hold a meta tag, and `charset` counts only as its own name.
fn document_charset(bytes: &[u8], kind: ContentKind) -> Option<String> {
    if kind != ContentKind::Html && kind != ContentKind::Xml {
        return None;
    }
    let head: String = bytes[..bytes.len().min(1024)]
        .iter()
        .map(|&b| b as char)
        .collect();
    let declared = XML_ENCODING.captures(&head).map(|c| c[1].to_string());
    if declared.is_some() || kind == ContentKind::Xml {
        return declared;
    }
    let markup = COMMENT.replace_all(&head, "");
    META_CHARSET.captures(&markup).map(|c| c[1].to_string())
}

/// The body as text, in the encoding its byte order mark names, else the charset
/// the `Content-Type` names, else the one the document declares, else UTF-8; an
/// encoding the decoder does not know reads as UTF-8.
fn decode(bytes: &[u8], content_type: &str, kind: ContentKind) -> String {
    let label = bom_encoding(bytes)
        .map(str::to_string)
        .or_else(|| {
            TYPE_CHARSET
                .captures(content_type)
                .map(|c| c[1].to_string())
        })
        .or_else(|| document_charset(bytes, kind));
    let encoding = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .filter(|e| *e != encoding_rs::REPLACEMENT)
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

/// The page as text for the model. The runtime's own lines come first, then the
/// source note, then everything the page controls, its title included.
async fn render(
    page_url: &str,
    content_type: &str,
    kind: ContentKind,
    bytes: Vec<u8>,
    capped: bool,
) -> anyhow::Result<(Outcome, String, Option<Extractor>)> {
    let text = decode(&bytes, content_type, kind);
    let mut lines: Vec<String> = vec![page_url.to_string()];
    if capped {
        lines.push(format!(
            "The page is larger than {MAX_BODY_MB} MB, so this is the text of its first {MAX_BODY_MB} MB."
        ));
    }
    if kind != ContentKind::Html {
        lines.extend([SOURCE_NOTE.to_string(), String::new(), text]);
        return Ok((Outcome::Ok, lines.join("\n"), None));
    }

    let (text, page) = convert(text, page_url.to_string()).await?;
    let extractor = Some(Extractor::from(page.extractor));
    if js_trim(&page.markdown).is_empty() {
        return Ok((
            Outcome::NoText,
            format!("{page_url} shows no text without JavaScript. Open it in the browser."),
            extractor,
        ));
    }
    static SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<script(?-u:\b)").unwrap());
    let visible: usize = page
        .markdown
        .chars()
        .filter(|&c| !is_js_whitespace(c))
        .map(char::len_utf16)
        .sum();
    if visible < MIN_TEXT_CHARS && SCRIPT.is_match(&text) {
        lines.push("The page shows little text without JavaScript. If what you need is missing, open it in the browser.".to_string());
    }
    lines.push(SOURCE_NOTE.to_string());
    if !page.title.is_empty() {
        lines.push(format!("Title: {}", page.title));
    }
    lines.push(String::new());
    lines.push(page.markdown);
    Ok((Outcome::Ok, lines.join("\n"), extractor))
}

/// Converts the page off the async threads, on a thread with room for a deeply
/// nested page, and hands the text back with the result.
async fn convert(
    text: String,
    page_url: String,
) -> anyhow::Result<(String, crate::lib::html_to_markdown::MarkdownPage)> {
    tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("web-fetch-markdown".to_string())
            .stack_size(256 * 1024 * 1024)
            .spawn(move || {
                let page = html_to_markdown(&text, &page_url)?;
                Ok((text, page))
            })?
            .join()
            .map_err(|_| anyhow::anyhow!("the page could not be converted"))?
    })
    .await?
}

/// `web_fetch`.
pub fn get_web_fetch_tools(user_id: &str, agent_id: &str) -> ToolSet {
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    let mut tools = ToolSet::new();
    tools.insert(
        WEB_FETCH_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(WEB_FETCH_DESCRIPTION.to_string()),
            input_schema: zod_schema(web_fetch_input_schema()),
            execute: Some(execute_fn(move |input, options| {
                let (user, agent) = (user.clone(), agent.clone());
                async move {
                    let input: WebFetchInput = serde_json::from_value(input)?;
                    let deps = WebFetchDeps {
                        abort_signal: options.abort_signal.clone(),
                        ..Default::default()
                    };
                    Ok(Value::String(
                        run_web_fetch(input, &user, &agent, deps).await?,
                    ))
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// Serves each connection the response `respond` gives for the request path.
    async fn serve(respond: fn(&str) -> Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let path = text.split(' ').nth(1).unwrap_or("/").to_string();
                    let _ = socket.write_all(&respond(&path)).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}")
    }

    fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn pages(path: &str) -> Vec<u8> {
        match path {
            "/article" => response(
                "200 OK",
                &[("content-type", "text/html; charset=utf-8")],
                b"<html><head><title>Plain page</title></head><body><p>Hello <a href=\"/next\">next</a>.</p></body></html>",
            ),
            "/data.json" => response("200 OK", &[("content-type", "application/json")], b"{\"a\":1}"),
            "/latin" => response("200 OK", &[("content-type", "text/plain; charset=iso-8859-1")], b"caf\xe9"),
            "/file.zip" => response("200 OK", &[("content-type", "application/zip")], b"PK"),
            "/missing" => response("404 Not Found", &[], b""),
            "/denied" => response("403 Forbidden", &[], b""),
            "/broken" => response("500 Internal Server Error", &[], b""),
            "/moved" => response("302 Found", &[("location", "/data.json")], b""),
            "/loop" => response("302 Found", &[("location", "/loop")], b""),
            "/scripted" => response(
                "200 OK",
                &[("content-type", "text/html")],
                b"<html><body><div id=app></div><script>render()</script></body></html>",
            ),
            _ => response("404 Not Found", &[], b""),
        }
    }

    fn loopback() -> WebFetchDeps {
        WebFetchDeps {
            assert_host: Some(Arc::new(|_| Ok(()))),
            client: Some(
                reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
            ),
            ..Default::default()
        }
    }

    async fn fetch(url: &str, deps: WebFetchDeps) -> Read {
        read_page(url, &deps).await.unwrap()
    }

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        let tools = get_web_fetch_tools("user-1", "agent-1");
        crate::tools::schema_fixture::assert_matches_fixture("web-fetch", &tools);
    }

    #[tokio::test]
    async fn returns_a_page_as_markdown_under_its_address_and_title() {
        let base = serve(pages).await;
        let read = fetch(&format!("{base}/article"), loopback()).await;
        assert_eq!(read.outcome, Outcome::Ok);
        assert_eq!(read.content_kind, Some(ContentKind::Html));
        assert_eq!(
            read.text,
            format!(
                "{base}/article\n{SOURCE_NOTE}\nTitle: Plain page\n\nHello [next]({base}/next)."
            )
        );
    }

    #[tokio::test]
    async fn returns_json_as_it_is_and_decodes_a_named_charset() {
        let base = serve(pages).await;
        let read = fetch(&format!("{base}/data.json"), loopback()).await;
        assert_eq!(
            read.text,
            format!("{base}/data.json\n{SOURCE_NOTE}\n\n{{\"a\":1}}")
        );
        let read = fetch(&format!("{base}/latin"), loopback()).await;
        assert!(read.text.ends_with("café"), "{}", read.text);
    }

    #[tokio::test]
    async fn follows_a_redirect_and_stops_after_the_limit() {
        let base = serve(pages).await;
        let read = fetch(&format!("{base}/moved"), loopback()).await;
        assert_eq!(read.redirects, 1);
        assert!(read.text.starts_with(&format!("{base}/data.json\n")));
        let read = fetch(&format!("{base}/loop"), loopback()).await;
        assert_eq!(read.outcome, Outcome::RedirectLimit);
        assert_eq!(
            read.text,
            format!("{base}/loop redirected more than 5 times, so web_fetch stopped.")
        );
    }

    #[tokio::test]
    async fn names_http_failures() {
        let base = serve(pages).await;
        let host = base.trim_start_matches("http://");
        assert_eq!(
            fetch(&format!("{base}/missing"), loopback()).await.text,
            format!("{base}/missing does not exist (HTTP 404).")
        );
        assert_eq!(
            fetch(&format!("{base}/denied"), loopback()).await.text,
            format!(
                "{host} refused the request (HTTP 403). The page may need a sign-in, or the site blocks automated readers. Open it in the browser."
            )
        );
        assert_eq!(
            fetch(&format!("{base}/broken"), loopback()).await.text,
            format!("{host} answered HTTP 500 for {base}/broken.")
        );
        let zip = fetch(&format!("{base}/file.zip"), loopback()).await;
        assert_eq!(zip.outcome, Outcome::UnsupportedType);
        assert_eq!(
            zip.text,
            format!(
                "web_fetch reads text pages, and {base}/file.zip is application/zip. Download it with the shell instead."
            )
        );
    }

    #[tokio::test]
    async fn hints_at_the_browser_for_a_page_that_needs_scripts() {
        let base = serve(pages).await;
        let read = fetch(&format!("{base}/scripted"), loopback()).await;
        assert_eq!(read.outcome, Outcome::NoText);
        assert_eq!(
            read.text,
            format!("{base}/scripted shows no text without JavaScript. Open it in the browser.")
        );
    }

    #[tokio::test]
    async fn refuses_a_private_address_and_a_bad_address() {
        let read = fetch("http://127.0.0.1:9/x", WebFetchDeps::default()).await;
        assert_eq!(read.outcome, Outcome::BlockedAddress);
        assert_eq!(
            read.text,
            "web_fetch reads public addresses only, and 127.0.0.1 is not public. Use the browser or the shell for a page on a private network."
        );
        let read = fetch("not a url", WebFetchDeps::default()).await;
        assert_eq!(read.outcome, Outcome::InvalidUrl);
        let read = fetch("ftp://example.com/x", WebFetchDeps::default()).await;
        assert_eq!(
            read.text,
            "web_fetch reads http and https addresses, and ftp://example.com/x is ftp."
        );
    }

    #[tokio::test]
    async fn stops_when_the_turn_is_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let deps = WebFetchDeps {
            abort_signal: Some(cancel),
            ..loopback()
        };
        let input = WebFetchInput {
            url: "http://192.0.2.1/slow".to_string(),
        };
        assert!(run_web_fetch(input, "u", "a", deps).await.is_err());
    }

    #[test]
    fn decodes_by_byte_order_mark_then_charset_then_meta() {
        assert_eq!(
            decode(
                &[0xff, 0xfe, b'h', 0, b'i', 0],
                "text/plain; charset=utf-8",
                ContentKind::Text
            ),
            "hi"
        );
        assert_eq!(
            decode(
                b"caf\xe9",
                "text/plain; charset=windows-1252",
                ContentKind::Text
            ),
            "café"
        );
        assert_eq!(
            document_charset(
                b"<!-- <meta charset=koi8-r> --><meta data-charset=x charset=\"iso-8859-2\">",
                ContentKind::Html
            ),
            Some("iso-8859-2".to_string())
        );
        assert_eq!(
            document_charset(
                b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss/>",
                ContentKind::Xml
            ),
            Some("ISO-8859-1".to_string())
        );
        assert_eq!(
            decode(b"x", "text/plain; charset=bogus", ContentKind::Text),
            "x"
        );
    }
}
