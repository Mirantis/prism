//! Using a browser tab from a tool call: go somewhere, click something, type.
//!
//! Every command answers with a reading of the page: the address, the title, the text,
//! and the names of the controls. The next command is written against those names.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::services::meeting::browser_stack::{Locator, PageHandle};

/// What the model asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAction {
    Navigate,
    Click,
    Type,
    Press,
    Scroll,
    Read,
    NewTab,
    SwitchTab,
    CloseTab,
}

impl BrowserAction {
    pub fn as_str(self) -> &'static str {
        match self {
            BrowserAction::Navigate => "navigate",
            BrowserAction::Click => "click",
            BrowserAction::Type => "type",
            BrowserAction::Press => "press",
            BrowserAction::Scroll => "scroll",
            BrowserAction::Read => "read",
            BrowserAction::NewTab => "new_tab",
            BrowserAction::SwitchTab => "switch_tab",
            BrowserAction::CloseTab => "close_tab",
        }
    }
}

/// What the model asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCommand {
    pub action: BrowserAction,
    /// Where to go, for `navigate` and for a `new_tab` that should land somewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Which tab, as numbered in the last reading. For `switch_tab` and `close_tab`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<f64>,
    /// What to act on: the words on it, or a CSS selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// What to type, for `type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A key name, for `press` — `Enter`, `Escape`, `PageDown`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// How far to scroll, in pixels; negative goes up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

/// Where the page ended up, in the terms the next command will be written in.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReading {
    pub url: String,
    pub title: String,
    /// The page's rendered text, cut to `TEXT_LIMIT`.
    pub text: String,
    /// Names of links, buttons and fields, in page order.
    pub controls: Vec<String>,
}

/// A command's answer: whether it worked, what happened, and the reading of the page.
///
/// The reading's fields sit beside `success` and `message`, in that order, and are left
/// out when there is no reading.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResult {
    pub success: bool,
    /// What happened, or why nothing did.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The page's rendered text, cut to `TEXT_LIMIT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Names of links, buttons and fields, in page order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<String>>,
    /// Every open tab, numbered as the next command must refer to them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<TabSummary>>,
}

impl BrowserResult {
    /// An answer with no reading attached.
    pub fn message(success: bool, message: impl Into<String>) -> Self {
        Self {
            success,
            message: message.into(),
            ..Self::default()
        }
    }

    /// An answer with the page's reading attached.
    pub fn with_reading(
        success: bool,
        message: impl Into<String>,
        reading: BrowserReading,
    ) -> Self {
        Self {
            success,
            message: message.into(),
            url: Some(reading.url),
            title: Some(reading.title),
            text: Some(reading.text),
            controls: Some(reading.controls),
            tabs: None,
        }
    }
}

/// One line of the tab list the model works from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSummary {
    /// What to pass as `tab`. Numbered from 1, because the agent says these out loud.
    pub number: i64,
    pub title: String,
    pub url: String,
    /// Whether this is the tab the commands act on, and the one the room sees.
    pub active: bool,
}

/// Cap on a page load. A page slower than this is one nobody wants shown.
const NAVIGATE_TIMEOUT_MS: u64 = 30_000;

/// Cap on a click, a fill or a keystroke, including waiting for the element.
const ACTION_TIMEOUT_MS: u64 = 10_000;

/// Cap on reading the page back afterwards.
const READ_TIMEOUT_MS: u64 = 5_000;

/// How much page text comes back.
///
/// A meeting caps a tool result at 12,000 characters. This limit is smaller because the
/// model has to say the answer out loud, so it measures what is worth speaking.
const TEXT_LIMIT: usize = 2_000;

/// How many control names come back, and how long each may be.
const CONTROL_LIMIT: usize = 40;
const CONTROL_NAME_LIMIT: usize = 60;

static HAS_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z]+://").expect("valid regex"));

/// Only an http(s) page can be shown to a room; `file:` and `chrome:` cannot.
pub fn normalize_url(raw: &str) -> Option<String> {
    let candidate = if HAS_SCHEME.is_match(raw) {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = url::Url::parse(&candidate).ok()?;
    if url.scheme() == "http" || url.scheme() == "https" {
        Some(url.to_string())
    } else {
        None
    }
}

static SELECTOR_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[#.\[]").expect("valid regex"));
static TAG_THEN_SELECTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9]*[#.\[>]").expect("valid regex"));

/// Whether a target reads as a CSS selector rather than as the words on a control.
///
/// The test is narrow. A model that writes `#search` or `input[name="q"]` means a
/// selector. Everything else is treated as text, because the reading gives it text.
pub fn looks_like_selector(target: &str) -> bool {
    SELECTOR_START.is_match(target) || TAG_THEN_SELECTOR.is_match(target)
}

/// Find the control the target names.
///
/// Roles come first, then labels and placeholders, then any text. "Sign in" more often
/// means the button than a heading with the same words, and a control whose text is an
/// icon is found by its accessible name only.
///
/// Exact first. A name matches as a substring by default, so "Sign in" also matches
/// "Sign in with Google", and an `or` resolves in document order rather than by how well
/// each side matched. The model writes the name it was given, so an exact hit is the one
/// it meant. The substring pass still covers a name the 60-character reading limit cut
/// short.
async fn locate(page: &PageHandle, target: &str) -> anyhow::Result<Locator> {
    todo!()
}

/// One locator that matches a button, a link, a text box, a label, a placeholder or plain
/// text with this name. `exact` chooses between a whole-name match and a substring match.
fn by_name(page: &PageHandle, target: &str, exact: bool) -> Locator {
    todo!()
}

/// The controls probe run in the page: the names of links, buttons and fields, from
/// `aria-label`, else `placeholder`, else the text, else `value`, whitespace collapsed,
/// trimmed and cut to `nameLimit`, unique, at most `limit` of them.
const CONTROLS_PROBE: &str = r#"({ limit, nameLimit }) => {
  const names = [];
  const seen = new Set();
  for (const el of Array.from(
    document.querySelectorAll('a, button, [role="button"], [role="link"], input, textarea, select'),
  )) {
    const name = (
      el.getAttribute('aria-label') ??
      el.getAttribute('placeholder') ??
      el.textContent ??
      el.getAttribute('value') ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, nameLimit);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}"#;

/// Read the page back: where it is, what it says, what can be clicked.
///
/// The title, the body text and the controls are read at once, each within
/// `READ_TIMEOUT_MS`, and each empty when it does not arrive. Runs of three or more
/// newlines in the text become two, and the text is trimmed and cut to `TEXT_LIMIT`.
pub async fn read(page: &PageHandle) -> BrowserReading {
    todo!()
}

/// JPEG, and not at full quality. The picture stays in the live session's context for
/// the rest of the call, and a lossless screenshot of a web page adds nothing the model
/// can use.
const SCREENSHOT_QUALITY: u8 = 75;
const SCREENSHOT_TIMEOUT_MS: u64 = 10_000;

/// List the open tabs for the model.
///
/// Numbered from 1, since the agent says these numbers out loud. A title that does not
/// arrive in time is left empty: the address alone still tells the model which tab it is.
pub async fn summarize_tabs(pages: &[PageHandle], active: Option<&PageHandle>) -> Vec<TabSummary> {
    todo!()
}

/// A picture of the page and the reading taken with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageCapture {
    /// The picture as a `data:image/jpeg;base64,…` URL.
    pub image_url: String,
    pub reading: BrowserReading,
}

/// A picture of the page, as a data URL, with the same reading attached.
pub async fn capture(page: &PageHandle) -> anyhow::Result<PageCapture> {
    todo!()
}

/// Run one command against a page.
///
/// A command that fails answers `success: false` and still carries the reading. Without
/// it the model cannot tell a click that missed from a click that went somewhere
/// unexpected.
///
/// The messages, by action: `navigate` answers `Say which URL to open.`,
/// `"{url}" is not a web address I can open.` or `Opened {url}`; `click` answers
/// `Say what to click.` or `Clicked "{target}"`; `type` answers `Say what to type.`,
/// `Typed into "{target}"` or `Typed` (typing where the cursor is, 20 ms a key, when no
/// target is given); `press` answers `Say which key to press.` or `Pressed {key}`, after
/// waiting up to `ACTION_TIMEOUT_MS` for a navigation the key started; `scroll` scrolls
/// `amount` (600 by default) and answers `Scrolled down` or `Scrolled up`; `read` answers
/// `Read the page`. The three tab actions belong to the browser, not to one page, and
/// answer `{action} is not a page command.`. A command that fails logs
/// `[Meeting:Browser] {action} failed: {first line of the error}` at info and answers
/// `That {action} did not work: {first line of the error}` with the reading.
pub async fn run_browser_command(page: &PageHandle, command: &BrowserCommand) -> BrowserResult {
    todo!()
}
