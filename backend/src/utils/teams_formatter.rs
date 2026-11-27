//! Teams Message Formatter
//!
//! Renders agent output as plain-markdown Teams message activities. Teams chat
//! renders a markdown subset that includes tables, so unlike the Slack
//! formatter there is no tables→bullets conversion and no block structure:
//! one formatted string per activity, chunked well below Teams' message size
//! limit (~28k chars) at paragraph boundaries.

use serde_json::Value;

use crate::support::js::trim as js_trim;
use crate::support::js::{len16, slice16};
use crate::utils::slack_formatter::unique_tool_names;
use crate::utils::text_chunker::split_content;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn triggered(by: &str) -> FormatTeamsMessageOptions {
        FormatTeamsMessageOptions {
            triggered_by: Some(by.to_string()),
            tool_calls: None,
        }
    }

    #[test]
    fn returns_the_content_as_a_single_chunk() {
        assert_eq!(format_teams_message("hello", None), vec!["hello"]);
    }

    #[test]
    fn renders_a_heartbeat_banner() {
        let chunks = format_teams_message("all clear", Some(&triggered("HEARTBEAT")));
        assert_eq!(chunks[0], "💓 **Heartbeat Alert**\n\nall clear");
    }

    #[test]
    fn renders_a_scheduled_task_banner() {
        let chunks = format_teams_message("done", Some(&triggered("CRON_TASK")));
        assert!(chunks[0].starts_with("⏰ **Scheduled Task Result**"));
    }

    #[test]
    fn renders_a_generic_banner_for_other_triggers() {
        let chunks = format_teams_message("hi", Some(&triggered("GOAL")));
        assert!(chunks[0].starts_with("📬 **GOAL**"));
    }

    #[test]
    fn adds_no_banner_for_user_input_or_a_webhook() {
        assert_eq!(
            format_teams_message("hi", Some(&triggered("USER_INPUT"))),
            vec!["hi"]
        );
        assert_eq!(
            format_teams_message("hi", Some(&triggered("WEBHOOK"))),
            vec!["hi"]
        );
    }

    #[test]
    fn appends_a_deduplicated_tool_footer() {
        let options = FormatTeamsMessageOptions {
            triggered_by: None,
            tool_calls: Some(vec![
                json!({ "tool": "shell_exec" }),
                json!({ "tool": "shell_exec" }),
                json!({ "tool": "memory_search" }),
            ]),
        };
        let chunks = format_teams_message("done", Some(&options));
        assert_eq!(chunks[0], "done\n\n🔧 _shell_exec, memory_search_");
    }

    #[test]
    fn passes_markdown_tables_through_unchanged() {
        let table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
        assert_eq!(format_teams_message(table, None), vec![table]);
    }

    #[test]
    fn renders_a_placeholder_for_empty_content() {
        assert_eq!(format_teams_message("   ", None), vec!["(empty message)"]);
    }

    #[test]
    fn chunks_over_limit_content_with_the_banner_first_and_the_footer_last() {
        let body = format!(
            "{}\n\n{}",
            "a".repeat(TEAMS_TEXT_LIMIT - 100),
            "b".repeat(TEAMS_TEXT_LIMIT - 100)
        );
        let options = FormatTeamsMessageOptions {
            triggered_by: Some("HEARTBEAT".to_string()),
            tool_calls: Some(vec![json!({ "tool": "kubectl" })]),
        };
        let chunks = format_teams_message(&body, Some(&options));
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].starts_with("💓 **Heartbeat Alert**"));
        assert!(!chunks[0].contains('🔧'));
        assert!(chunks[1].ends_with("🔧 _kubectl_"));
        for chunk in &chunks {
            assert!(len16(chunk) <= TEAMS_TEXT_LIMIT + 100);
        }
    }

    #[test]
    fn names_the_channel_as_teams_shows_it() {
        assert!(
            teams_channel_label("General").contains("the Microsoft Teams channel **General**,")
        );
    }

    // Teams shows a token in a reply as text, so the agent writes the name.
    #[test]
    fn tells_the_agent_to_address_people_by_name_not_by_token() {
        let label = teams_channel_label("General");
        assert!(label.contains("address people by name"));
        assert!(!label.contains("writing their token"));
    }
}
