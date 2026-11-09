//! Using a browser tab from a tool call: go somewhere, click something, type.
//!
//! Every command answers with a reading of the page: the address, the title, the text,
//! and the names of the controls. The next command is written against those names.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use serde_json::json;

use crate::log_info;
use crate::services::meeting::browser_stack::{
    GotoOptions, LoadState, Locator, PageHandle, ScreenshotOptions, ScreenshotType, TextMatch,
};
use crate::utils::with_timeout::with_timeout;

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
    if looks_like_selector(target) {
        return Ok(page.locator(target).first());
    }

    let exact = by_name(page, target, true);
    if exact.count().await? > 0 {
        return Ok(exact.first());
    }

    Ok(by_name(page, target, false).first())
}

/// One locator that matches a button, a link, a text box, a label, a placeholder or plain
/// text with this name. `exact` chooses between a whole-name match and a substring match.
fn by_name(page: &PageHandle, target: &str, exact: bool) -> Locator {
    let name = || TextMatch::Text {
        text: target.to_string(),
        exact,
    };
    page.get_by_role("button", Some(name()))
        .or(page.get_by_role("link", Some(name())))
        .or(page.get_by_role("textbox", Some(name())))
        .or(page.get_by_label(name()))
        .or(page.get_by_placeholder(name()))
        .or(page.get_by_text(name()))
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
    static BLANK_RUNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\n{3,}").expect("valid regex"));
    let timeout = READ_TIMEOUT_MS as i64;
    let body = page.locator("body");

    let (title, text, controls) = tokio::join!(
        with_timeout(page.title(), timeout),
        with_timeout(body.inner_text(Some(READ_TIMEOUT_MS)), timeout),
        with_timeout(
            page.evaluate_function(
                CONTROLS_PROBE,
                json!({ "limit": CONTROL_LIMIT, "nameLimit": CONTROL_NAME_LIMIT }),
            ),
            timeout,
        ),
    );
    let title = title.unwrap_or_default();
    let text = text.unwrap_or_default();
    let controls: Vec<String> = controls
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();

    let text = BLANK_RUNS.replace_all(&text, "\n\n");
    let text = crate::support::js::trim(&text);
    BrowserReading {
        url: page.url(),
        title,
        text: crate::support::js::slice16(text, 0, TEXT_LIMIT),
        controls,
    }
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
    futures::future::join_all(pages.iter().enumerate().map(|(index, page)| async move {
        TabSummary {
            number: index as i64 + 1,
            title: with_timeout(page.title(), READ_TIMEOUT_MS as i64)
                .await
                .unwrap_or_default(),
            url: page.url(),
            active: active == Some(page),
        }
    }))
    .await
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
    use base64::Engine as _;

    let (shot, reading) = tokio::join!(
        with_timeout(
            page.screenshot(ScreenshotOptions {
                kind: ScreenshotType::Jpeg,
                quality: Some(SCREENSHOT_QUALITY),
                timeout_ms: Some(SCREENSHOT_TIMEOUT_MS),
                path: None,
            }),
            SCREENSHOT_TIMEOUT_MS as i64,
        ),
        read(page),
    );
    let shot = shot?;

    Ok(PageCapture {
        image_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(shot)
        ),
        reading,
    })
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
    match attempt(page, command).await {
        Ok(result) => result,
        Err(err) => {
            let text = err.to_string();
            let detail = text.split('\n').next().unwrap_or_default();
            let action = command.action.as_str();
            log_info!("[Meeting:Browser] {} failed: {}", action, detail);
            BrowserResult::with_reading(
                false,
                format!("That {action} did not work: {detail}"),
                read(page).await,
            )
        }
    }
}

/// The command itself; an error is a command that failed, which the caller reports.
async fn attempt(page: &PageHandle, command: &BrowserCommand) -> anyhow::Result<BrowserResult> {
    let done = |message: String| async move {
        BrowserResult::with_reading(true, message, read(page).await)
    };

    match command.action {
        BrowserAction::Navigate => {
            let Some(raw) = command.url.as_deref().filter(|url| !url.is_empty()) else {
                return Ok(BrowserResult::message(false, "Say which URL to open."));
            };
            let Some(url) = normalize_url(raw) else {
                return Ok(BrowserResult::message(
                    false,
                    format!("\"{raw}\" is not a web address I can open."),
                ));
            };
            page.goto(
                &url,
                GotoOptions {
                    wait_until: LoadState::DomContentLoaded,
                    timeout_ms: Some(NAVIGATE_TIMEOUT_MS),
                },
            )
            .await?;
            Ok(done(format!("Opened {url}")).await)
        }

        BrowserAction::Click => {
            let Some(target) = command.target.as_deref().filter(|t| !t.is_empty()) else {
                return Ok(BrowserResult::message(false, "Say what to click."));
            };
            locate(page, target).await?.click(ACTION_TIMEOUT_MS).await?;
            Ok(done(format!("Clicked \"{target}\"")).await)
        }

        BrowserAction::Type => {
            let Some(text) = command.text.as_deref() else {
                return Ok(BrowserResult::message(false, "Say what to type."));
            };
            let target = command.target.as_deref().filter(|t| !t.is_empty());
            if let Some(target) = target {
                locate(page, target)
                    .await?
                    .fill(text, ACTION_TIMEOUT_MS)
                    .await?;
            } else {
                // No target: type wherever the page put the cursor, which is what a person
                // does after clicking a field.
                page.keyboard_type(text, 20).await?;
            }
            Ok(done(match target {
                Some(target) => format!("Typed into \"{target}\""),
                None => "Typed".to_string(),
            })
            .await)
        }

        BrowserAction::Press => {
            let Some(key) = command.key.as_deref().filter(|k| !k.is_empty()) else {
                return Ok(BrowserResult::message(false, "Say which key to press."));
            };
            page.keyboard_press(key).await?;
            // A key can start a navigation (Enter in a search box), and the reading has to
            // be of where that lands rather than of the page being left.
            let _ = page
                .wait_for_load_state(LoadState::DomContentLoaded, ACTION_TIMEOUT_MS)
                .await;
            Ok(done(format!("Pressed {key}")).await)
        }

        BrowserAction::Scroll => {
            let amount = command.amount.unwrap_or(600.0);
            page.mouse_wheel(0.0, amount).await?;
            let message = if amount >= 0.0 {
                "Scrolled down"
            } else {
                "Scrolled up"
            };
            Ok(done(message.to_string()).await)
        }

        BrowserAction::Read => Ok(done("Read the page".to_string()).await),

        // The set of tabs belongs to the browser, not to one page. `browse` in
        // `meeting_bot_service.rs` answers these.
        BrowserAction::NewTab | BrowserAction::SwitchTab | BrowserAction::CloseTab => {
            Ok(BrowserResult::message(
                false,
                format!("{} is not a page command.", command.action.as_str()),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::browser_stack::testing::FakeBrowser;

    #[test]
    fn takes_a_selector_for_a_selector_and_words_for_words() {
        assert!(looks_like_selector("#search"));
        assert!(looks_like_selector(".btn-primary"));
        assert!(looks_like_selector("input[name=\"q\"]"));
        assert!(!looks_like_selector("Sign in"));
        assert!(!looks_like_selector("Search the docs"));
    }

    #[test]
    fn opens_a_bare_host_as_https_and_refuses_other_schemes() {
        assert_eq!(
            normalize_url("example.test").as_deref(),
            Some("https://example.test/")
        );
        assert_eq!(
            normalize_url("http://example.test/a?b=1").as_deref(),
            Some("http://example.test/a?b=1")
        );
        assert_eq!(normalize_url("file:///etc/passwd"), None);
        assert_eq!(normalize_url("chrome://settings"), None);
    }

    fn command(action: BrowserAction) -> BrowserCommand {
        BrowserCommand {
            action,
            url: None,
            tab: None,
            target: None,
            text: None,
            key: None,
            amount: None,
        }
    }

    #[tokio::test]
    async fn answers_a_command_with_a_missing_argument_instead_of_failing() {
        let fake = FakeBrowser::new();
        let page = fake.page("https://example.test/");
        for action in [
            BrowserAction::Navigate,
            BrowserAction::Click,
            BrowserAction::Type,
            BrowserAction::Press,
        ] {
            let result = run_browser_command(&page, &command(action)).await;
            assert!(!result.success);
            assert!(
                result.message.starts_with("Say which") || result.message.starts_with("Say what"),
                "{}",
                result.message
            );
            assert_eq!(result.url, None);
        }
        assert!(fake.sent_to(&page).is_empty());
    }

    #[tokio::test]
    async fn refuses_a_scheme_a_room_could_not_be_shown() {
        // The point of the browser is what the room sees, and a screen share of
        // `file:///etc/passwd` is a different kind of event.
        let fake = FakeBrowser::new();
        let page = fake.page("https://example.test/");
        let mut navigate = command(BrowserAction::Navigate);
        navigate.url = Some("file:///etc/passwd".to_string());
        let result = run_browser_command(&page, &navigate).await;
        assert!(!result.success);
        assert_eq!(
            result.message,
            "\"file:///etc/passwd\" is not a web address I can open."
        );
        assert!(fake.sent_to(&page).is_empty());
    }

    #[tokio::test]
    async fn answers_a_tab_action_as_not_a_page_command() {
        let fake = FakeBrowser::new();
        let page = fake.page("https://example.test/");
        let result = run_browser_command(&page, &command(BrowserAction::NewTab)).await;
        assert_eq!(
            result,
            BrowserResult::message(false, "new_tab is not a page command.")
        );
    }

    #[test]
    fn serializes_a_result_with_the_reading_beside_success_and_message() {
        let result = BrowserResult::with_reading(
            true,
            "Read the page",
            BrowserReading {
                url: "https://example.test/".into(),
                title: "Example".into(),
                text: "Hi".into(),
                controls: vec!["Sign in".into()],
            },
        );
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"success":true,"message":"Read the page","url":"https://example.test/","title":"Example","text":"Hi","controls":["Sign in"]}"#
        );
        assert_eq!(
            serde_json::to_string(&BrowserResult::message(false, "Say what to click.")).unwrap(),
            r#"{"success":false,"message":"Say what to click."}"#
        );
    }
}
