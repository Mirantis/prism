//! Teams Message Formatter
//!
//! Renders agent output as plain-markdown Teams message activities. Teams chat
//! renders a markdown subset that includes tables, so unlike the Slack
//! formatter there is no tables→bullets conversion and no block structure:
//! one formatted string per activity, chunked well below Teams' message size
//! limit (~28k chars) at paragraph boundaries.

use serde_json::Value;

use crate::support::js::{len16, slice16};
use crate::utils::slack_formatter::unique_tool_names;
use crate::utils::text_chunker::{js_trim, split_content};

/// Per-activity text budget: a safe bound below Teams' ~28k char limit.
pub const TEAMS_TEXT_LIMIT: usize = 25_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FormatTeamsMessageOptions {
    /// Message source (HEARTBEAT, CRON_TASK, …), rendered as a banner line.
    pub triggered_by: Option<String>,
    /// Tool calls made during the turn (each with a `tool` name), rendered as a one-line footer.
    pub tool_calls: Option<Vec<Value>>,
}

/// Format a message for Teams: returns one or more activity texts, in send
/// order. The triggered-by banner leads the first chunk and the tool footer
/// trails the last, so a chunked message has each exactly once.
pub fn format_teams_message(
    content: &str,
    options: Option<&FormatTeamsMessageOptions>,
) -> Vec<String> {
    let triggered_by = options.and_then(|o| o.triggered_by.as_deref());
    let tool_calls = options.and_then(|o| o.tool_calls.as_deref());

    // A webhook message is its body alone.
    let banner =
        match triggered_by.filter(|t| !t.is_empty() && *t != "USER_INPUT" && *t != "WEBHOOK") {
            Some("HEARTBEAT") => "\u{1f493} **Heartbeat Alert**".to_string(),
            Some("CRON_TASK") => "\u{23f0} **Scheduled Task Result**".to_string(),
            Some(other) => format!("\u{1f4ec} **{other}**"),
            None => String::new(),
        };

    let footer = match tool_calls.filter(|calls| !calls.is_empty()) {
        Some(calls) => format!("\u{1f527} _{}_", unique_tool_names(calls)),
        None => String::new(),
    };

    let trimmed = js_trim(content);
    let body = if trimmed.is_empty() {
        "(empty message)"
    } else {
        trimmed
    };
    let mut chunks = if len16(body) <= TEAMS_TEXT_LIMIT {
        vec![body.to_string()]
    } else {
        split_content(body, TEAMS_TEXT_LIMIT)
    };
    if chunks.is_empty() {
        chunks.push(slice16(body, 0, TEAMS_TEXT_LIMIT));
    }

    if !banner.is_empty() {
        chunks[0] = format!("{banner}\n\n{}", chunks[0]);
    }
    if !footer.is_empty() {
        let last = chunks.len() - 1;
        chunks[last] = format!("{}\n\n{footer}", chunks[last]);
    }

    chunks
}

/// How the system prompt names a Teams channel, with what the agent sees of a thread there and how
/// it addresses someone: the adapter keeps a thread from the message that first mentioned the
/// agent, and Teams shows a token in a reply as text.
pub fn teams_channel_label(channel_name: &str) -> String {
    format!(
        "the Microsoft Teams channel **{channel_name}**, where you see this thread from the message \
         that first mentioned you, where you address people by name, because Teams shows a \
         token as text, and where you suggest a direct message for sensitive data"
    )
}
