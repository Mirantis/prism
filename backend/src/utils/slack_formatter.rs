//! Slack Message Formatter
//!
//! Uses Slack's native markdown block, which accepts standard markdown directly.
//!
//! Reference: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
//!
//! Supported: Bold, italic, strikethrough, headers, lists, blockquotes,
//!            inline code, code blocks, links, images (as links)
//! Not supported: Tables, syntax highlighting, horizontal rules

use std::sync::LazyLock;

use indexmap::IndexSet;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::support::js::{len16, trim as js_trim};
use crate::utils::text_chunker::split_content;

/// A `mrkdwn` text object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "mrkdwn")]
pub struct MrkdwnText {
    pub text: String,
}

/// A `plain_text` text object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "plain_text")]
pub struct PlainText {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "button")]
pub struct ButtonElement {
    pub action_id: String,
    pub text: PlainText,
    pub value: String,
}

/// Slack Block Kit blocks the runtime sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SlackBlock {
    Markdown {
        text: String,
    },
    Section {
        text: MrkdwnText,
    },
    Context {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        elements: Vec<MrkdwnText>,
    },
    Actions {
        block_id: String,
        elements: Vec<ButtonElement>,
    },
}

impl SlackBlock {
    fn context(text: impl Into<String>) -> Self {
        SlackBlock::Context {
            block_id: None,
            elements: vec![MrkdwnText { text: text.into() }],
        }
    }

    fn markdown(text: impl Into<String>) -> Self {
        SlackBlock::Markdown { text: text.into() }
    }
}

/// Individual block text limit
const BLOCK_TEXT_LIMIT: usize = 3000;

// ============================================================================
// Feedback buttons (👍 / 👎 on agent responses)
// ============================================================================

pub const FEEDBACK_BLOCK_ID: &str = "lens_feedback";
pub const FEEDBACK_ACK_BLOCK_ID: &str = "lens_feedback_ack";
pub const FEEDBACK_ACTION_UP: &str = "feedback_thumbs_up";
pub const FEEDBACK_ACTION_DOWN: &str = "feedback_thumbs_down";

pub const FEEDBACK_RATING_UP: &str = "up";
pub const FEEDBACK_RATING_DOWN: &str = "down";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackRating {
    Up,
    Down,
}

impl FeedbackRating {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Up => FEEDBACK_RATING_UP,
            Self::Down => FEEDBACK_RATING_DOWN,
        }
    }
}

/// Inline acknowledgement block rendered in place of the feedback buttons after
/// a click. Generic wording on purpose: in channel/team mode the update is
/// visible to everyone, not just the clicker, so it does not claim "you rated this".
pub fn build_feedback_ack_block() -> SlackBlock {
    SlackBlock::Context {
        block_id: Some(FEEDBACK_ACK_BLOCK_ID.to_string()),
        elements: vec![MrkdwnText {
            text: "_\u{2713} Thanks for the feedback!_".to_string(),
        }],
    }
}

/// Build the actions block containing 👍 / 👎 feedback buttons for an agent message.
/// The button `value` carries the internal message ID so the action handler can
/// correlate the click back to a ConversationMessage.
pub fn build_feedback_actions_block(message_id: &str) -> SlackBlock {
    SlackBlock::Actions {
        block_id: FEEDBACK_BLOCK_ID.to_string(),
        elements: vec![
            ButtonElement {
                action_id: FEEDBACK_ACTION_UP.to_string(),
                text: PlainText {
                    text: "\u{1f44d} Helpful".to_string(),
                    emoji: Some(true),
                },
                value: message_id.to_string(),
            },
            ButtonElement {
                action_id: FEEDBACK_ACTION_DOWN.to_string(),
                text: PlainText {
                    text: "\u{1f44e} Not helpful".to_string(),
                    emoji: Some(true),
                },
                value: message_id.to_string(),
            },
        ],
    }
}

/// A markdown table: a row, the divider row, and one or more rows.
static TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(\|[^\n\r\u{2028}\u{2029}]+\|[\r\n]+\|[-:\s|]+\|[\r\n]+(?:\|[^\n\r\u{2028}\u{2029}]+\|[\r\n]*)+)",
    )
    .expect("valid regex")
});

static DIVIDER_CELL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-:]+$").expect("valid regex"));

/// Convert markdown tables to a simple text format since markdown blocks don't support tables.
fn convert_tables_to_text(content: &str) -> String {
    TABLE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let matched = &caps[0];
            let lines: Vec<&str> = js_trim(matched).split('\n').collect();
            if lines.len() < 3 {
                return matched.to_string();
            }

            // Parse header and rows
            let parse_row = |row: &str| -> Vec<String> {
                row.split('|')
                    .map(|cell| js_trim(cell).to_string())
                    .filter(|cell| !cell.is_empty() && !DIVIDER_CELL.is_match(cell))
                    .collect()
            };

            let headers = parse_row(lines[0]);
            let rows: Vec<Vec<String>> = lines[2..]
                .iter()
                .filter(|line| !js_trim(line).is_empty())
                .map(|line| parse_row(line))
                .collect();

            // Convert to bullet list format
            rows.iter()
                .map(|row| {
                    let items: Vec<String> = row
                        .iter()
                        .enumerate()
                        .map(|(i, cell)| {
                            let header = headers
                                .get(i)
                                .filter(|header| !header.is_empty())
                                .cloned()
                                .unwrap_or_else(|| format!("Col{}", i + 1));
                            format!("**{header}:** {cell}")
                        })
                        .collect();
                    format!("\u{2022} {}", items.join(" | "))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .into_owned()
}

/// Options for extending the formatted message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FormatSlackMessageOptions {
    /// When set, append a 👍/👎 feedback actions block keyed by this message id.
    /// The caller is responsible for gating (length / cadence / terminal-only).
    pub feedback_message_id: Option<String>,
}

/// A message ready for `chat.postMessage`: the fallback text and the blocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormattedSlackMessage {
    pub text: String,
    pub blocks: Vec<SlackBlock>,
}

/// The distinct `tool` names of stored tool calls, in first-seen order, as
/// `[...new Set(toolCalls.map((tc) => tc.tool))].join(', ')` writes them.
pub(crate) fn unique_tool_names(tool_calls: &[Value]) -> String {
    let names: IndexSet<String> = tool_calls
        .iter()
        .map(|tc| match tc.get("tool") {
            Some(Value::String(name)) => name.clone(),
            None | Some(Value::Null) => String::new(),
            Some(other) => other.to_string(),
        })
        .collect();
    names.into_iter().collect::<Vec<_>>().join(", ")
}

/// Format a message for Slack using native markdown blocks.
pub fn format_slack_message(
    content: &str,
    triggered_by: Option<&str>,
    tool_calls: Option<&[Value]>,
    options: Option<&FormatSlackMessageOptions>,
) -> FormattedSlackMessage {
    let mut blocks: Vec<SlackBlock> = Vec::new();

    // Add context block for triggered by info. A webhook message is its body alone.
    if let Some(triggered_by) =
        triggered_by.filter(|t| !t.is_empty() && *t != "USER_INPUT" && *t != "WEBHOOK")
    {
        let context_text = match triggered_by {
            "HEARTBEAT" => "\u{1f493} Heartbeat Alert".to_string(),
            "CRON_TASK" => "\u{23f0} Scheduled Task Result".to_string(),
            other => format!("\u{1f4ec} {other}"),
        };
        blocks.push(SlackBlock::context(context_text));
    }

    // Convert tables to text format (markdown blocks don't support tables)
    let processed_content = convert_tables_to_text(content);
    let processed_length = len16(&processed_content);

    // Split into chunks if content is too long
    if processed_length > 0 && processed_length <= BLOCK_TEXT_LIMIT {
        // Single markdown block
        blocks.push(SlackBlock::markdown(processed_content));
    } else if processed_length > BLOCK_TEXT_LIMIT {
        // Split by paragraphs/sections to stay within limits
        for section in split_content(&processed_content, BLOCK_TEXT_LIMIT) {
            if !js_trim(&section).is_empty() {
                blocks.push(SlackBlock::markdown(section));
            }
        }
    }

    // Append tool call context block
    if let Some(tool_calls) = tool_calls.filter(|calls| !calls.is_empty()) {
        blocks.push(SlackBlock::context(format!(
            "\u{1f527} {}",
            unique_tool_names(tool_calls)
        )));
    }

    // Ensure we have at least one block
    let only_context = blocks.len() == 1 && matches!(blocks[0], SlackBlock::Context { .. });
    if blocks.is_empty() || only_context {
        let text = if content.is_empty() {
            "(empty message)"
        } else {
            content
        };
        blocks.push(SlackBlock::markdown(text));
    }

    // Append feedback buttons on the final message of a turn (caller decides when to pass this)
    if let Some(message_id) = options
        .and_then(|o| o.feedback_message_id.as_deref())
        .filter(|id| !id.is_empty())
    {
        blocks.push(build_feedback_actions_block(message_id));
    }

    // Slack has a limit of 50 blocks
    if blocks.len() > 50 {
        blocks.truncate(49);
        blocks.push(SlackBlock::context("_Message truncated due to length..._"));
    }

    FormattedSlackMessage {
        // Fallback plain text for notifications
        text: content.to_string(),
        blocks,
    }
}

/// The kind of a notification, which picks its emoji.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NotificationType {
    #[default]
    Info,
    Warning,
    Error,
    Success,
}

/// Format a simple notification message.
pub fn format_notification(
    title: &str,
    message: &str,
    kind: NotificationType,
) -> FormattedSlackMessage {
    let emoji = match kind {
        NotificationType::Info => "\u{2139}\u{fe0f}",
        NotificationType::Warning => "\u{26a0}\u{fe0f}",
        NotificationType::Error => "\u{1f6a8}",
        NotificationType::Success => "\u{2705}",
    };

    FormattedSlackMessage {
        text: format!("{emoji} {title}: {message}"),
        blocks: vec![SlackBlock::markdown(format!(
            "{emoji} **{title}**\n\n{message}"
        ))],
    }
}

static LEADING_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#").expect("valid regex"));

/// How the system prompt names a Slack channel, `#` included once, with what the agent sees of a
/// thread there and how it mentions someone: the adapter reads the whole thread, and turns a
/// person's token in a reply into a mention.
pub fn slack_channel_label(channel_name: &str) -> String {
    format!(
        "the team Slack channel **#{}**, where you see the messages of \
         the thread you reply in, where you mention someone by writing their token as it \
         appears, so Slack notifies them, and where you suggest a direct message for sensitive data",
        LEADING_HASH.replace(channel_name, "")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block_json(block: &SlackBlock) -> Value {
        serde_json::to_value(block).unwrap()
    }

    fn markdown_texts(message: &FormattedSlackMessage) -> Vec<String> {
        message
            .blocks
            .iter()
            .filter_map(|b| match b {
                SlackBlock::Markdown { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn first_markdown(message: &FormattedSlackMessage) -> String {
        markdown_texts(message).into_iter().next().unwrap()
    }

    fn format(content: &str) -> FormattedSlackMessage {
        format_slack_message(content, None, None, None)
    }

    // formatSlackMessage: basic content

    #[test]
    fn wraps_short_content_in_a_single_markdown_block() {
        let result = format("Hello world");
        assert_eq!(result.text, "Hello world");
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "markdown", "text": "Hello world" })
        );
    }

    #[test]
    fn returns_a_fallback_block_for_empty_content() {
        let result = format("");
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "markdown", "text": "(empty message)" })
        );
    }

    #[test]
    fn preserves_whitespace_only_content_in_a_single_markdown_block() {
        let result = format("   ");
        assert_eq!(result.text, "   ");
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "markdown", "text": "   " })
        );
    }

    // triggeredBy context blocks

    #[test]
    fn adds_a_heartbeat_context_block() {
        let result = format_slack_message("alert", Some("HEARTBEAT"), None, None);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "💓 Heartbeat Alert" }] })
        );
    }

    #[test]
    fn adds_a_cron_task_context_block() {
        let result = format_slack_message("report", Some("CRON_TASK"), None, None);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "⏰ Scheduled Task Result" }] })
        );
    }

    #[test]
    fn adds_a_custom_trigger_context_block() {
        let result = format_slack_message("msg", Some("GOAL"), None, None);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "📬 GOAL" }] })
        );
    }

    #[test]
    fn adds_no_context_block_for_a_webhook() {
        let result = format_slack_message("msg", Some("WEBHOOK"), None, None);
        assert_eq!(result.blocks.len(), 1);
        assert!(matches!(result.blocks[0], SlackBlock::Markdown { .. }));
    }

    #[test]
    fn adds_no_context_block_for_user_input() {
        let result = format_slack_message("msg", Some("USER_INPUT"), None, None);
        assert!(
            !result
                .blocks
                .iter()
                .any(|b| matches!(b, SlackBlock::Context { .. }))
        );
        assert_eq!(result.blocks.len(), 1);
        assert!(matches!(result.blocks[0], SlackBlock::Markdown { .. }));
    }

    #[test]
    fn adds_no_context_block_without_a_trigger() {
        let result = format("msg");
        assert_eq!(result.blocks.len(), 1);
        assert!(matches!(result.blocks[0], SlackBlock::Markdown { .. }));
    }

    // toolCalls context

    #[test]
    fn appends_a_tool_context_block_with_unique_tool_names() {
        let calls = [
            json!({ "tool": "kubectl" }),
            json!({ "tool": "github" }),
            json!({ "tool": "kubectl" }),
        ];
        let result = format_slack_message("done", None, Some(&calls), None);
        assert_eq!(
            block_json(result.blocks.last().unwrap()),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "🔧 kubectl, github" }] })
        );
    }

    #[test]
    fn adds_no_tool_block_when_there_are_no_tool_calls() {
        let result = format_slack_message("done", None, Some(&[]), None);
        assert_eq!(result.blocks.len(), 1);
    }

    // Table conversion

    #[test]
    fn converts_a_markdown_table_to_a_bullet_list() {
        let table = [
            "| Name | Status |",
            "| --- | --- |",
            "| svc-a | healthy |",
            "| svc-b | degraded |",
        ]
        .join("\n");
        let text = first_markdown(&format(&table));
        assert!(text.contains("• **Name:** svc-a | **Status:** healthy"));
        assert!(text.contains("• **Name:** svc-b | **Status:** degraded"));
        assert!(!text.contains("| Name | Status |"));
    }

    #[test]
    fn preserves_non_table_content_around_a_table() {
        let text = first_markdown(&format(
            "Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter",
        ));
        assert!(text.contains("Before"));
        assert!(text.contains("After"));
        assert!(text.contains("• **A:** 1 | **B:** 2"));
    }

    #[test]
    fn leaves_content_alone_when_there_is_no_table() {
        let content = "Just some text\nwith newlines";
        assert_eq!(first_markdown(&format(content)), content);
    }

    // Content splitting for long messages

    #[test]
    fn splits_content_over_3000_characters_into_several_blocks() {
        let para = "A".repeat(1000);
        let content = format!("{para}\n\n{para}\n\n{para}\n\n{para}");
        assert!(markdown_texts(&format(&content)).len() > 1);
    }

    #[test]
    fn splits_a_single_very_long_paragraph_at_a_sentence_boundary() {
        let content = "This is a test sentence. ".repeat(200);
        let blocks = markdown_texts(&format(&content));
        assert!(blocks.len() > 1);
        for text in blocks {
            assert!(len16(&text) <= 3000);
        }
    }

    #[test]
    fn hard_splits_text_with_no_natural_break_points() {
        let content = "X".repeat(7000);
        let blocks = markdown_texts(&format(&content));
        assert!(blocks.len() > 1);
        assert_eq!(blocks.concat(), content);
    }

    #[test]
    fn splits_at_a_newline_when_no_sentence_boundary_exists() {
        let line = "word ".repeat(100);
        let content = [js_trim(&line); 10].join("\n");
        assert!(markdown_texts(&format(&content)).len() > 1);
    }

    // 50-block truncation

    #[test]
    fn truncates_to_50_blocks_with_a_truncation_notice() {
        let para = "B".repeat(2999);
        let content = vec![para.as_str(); 55].join("\n\n");
        let result = format(&content);
        assert_eq!(result.blocks.len(), 50);
        assert_eq!(
            block_json(&result.blocks[49]),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "_Message truncated due to length..._" }] })
        );
    }

    // Fallback when only context blocks

    #[test]
    fn adds_a_fallback_markdown_block_when_content_is_empty_but_a_trigger_exists() {
        let result = format_slack_message("", Some("HEARTBEAT"), None, None);
        assert!(!markdown_texts(&result).is_empty());
    }

    // formatNotification

    #[test]
    fn formats_an_info_notification() {
        let result = format_notification("Deploy", "v1.2.3 released", NotificationType::default());
        assert_eq!(result.text, "ℹ️ Deploy: v1.2.3 released");
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(
            block_json(&result.blocks[0]),
            json!({ "type": "markdown", "text": "ℹ️ **Deploy**\n\nv1.2.3 released" })
        );
    }

    #[test]
    fn formats_a_warning_notification() {
        let result = format_notification("Disk", "low space", NotificationType::Warning);
        assert!(result.text.contains("⚠️"));
    }

    #[test]
    fn formats_an_error_notification() {
        let result = format_notification("Crash", "OOM killed", NotificationType::Error);
        assert!(result.text.contains("🚨"));
    }

    #[test]
    fn formats_a_success_notification() {
        let result = format_notification("Build", "passed", NotificationType::Success);
        assert!(result.text.contains("✅"));
    }

    #[test]
    fn a_notification_defaults_to_info() {
        let result = format_notification("Test", "msg", NotificationType::default());
        assert!(result.text.contains("ℹ️"));
    }

    // Feedback actions block

    #[test]
    fn omits_the_feedback_block_by_default() {
        let result = format("Some substantive content to analyse.");
        assert!(
            !result
                .blocks
                .iter()
                .any(|b| matches!(b, SlackBlock::Actions { .. }))
        );
    }

    #[test]
    fn appends_the_feedback_block_when_a_feedback_message_id_is_given() {
        let result = format_slack_message(
            "Some substantive content to analyse.",
            None,
            None,
            Some(&FormatSlackMessageOptions {
                feedback_message_id: Some("msg-42".into()),
            }),
        );
        let actions = result
            .blocks
            .iter()
            .find(|b| matches!(b, SlackBlock::Actions { .. }))
            .unwrap();
        assert_eq!(actions, &build_feedback_actions_block("msg-42"));
    }

    #[test]
    fn the_feedback_block_carries_the_message_id_on_both_buttons() {
        let block = block_json(&build_feedback_actions_block("msg-abc"));
        assert_eq!(block["block_id"], FEEDBACK_BLOCK_ID);
        assert_eq!(block["elements"].as_array().unwrap().len(), 2);
        assert_eq!(block["elements"][0]["type"], "button");
        assert_eq!(block["elements"][0]["action_id"], FEEDBACK_ACTION_UP);
        assert_eq!(block["elements"][0]["value"], "msg-abc");
        assert_eq!(block["elements"][1]["type"], "button");
        assert_eq!(block["elements"][1]["action_id"], FEEDBACK_ACTION_DOWN);
        assert_eq!(block["elements"][1]["value"], "msg-abc");
    }

    #[test]
    fn the_feedback_block_comes_after_the_tool_calls_block() {
        let result = format_slack_message(
            "Substantive content.",
            None,
            Some(&[json!({ "tool": "kubectl" })]),
            Some(&FormatSlackMessageOptions {
                feedback_message_id: Some("msg-42".into()),
            }),
        );
        assert!(matches!(
            result.blocks.last().unwrap(),
            SlackBlock::Actions { .. }
        ));
    }

    #[test]
    fn the_feedback_ack_is_a_generic_thank_you() {
        let ack = block_json(&build_feedback_ack_block());
        assert_eq!(ack["type"], "context");
        let text = ack["elements"][0]["text"].as_str().unwrap();
        assert!(text.contains("Thanks for the feedback"));
        assert!(!text.to_lowercase().contains("you rated"));
        assert!(!text.contains('👍'));
        assert!(!text.contains('👎'));
    }

    #[test]
    fn writes_every_block_key_in_slack_order() {
        let message = format_slack_message(
            "hello",
            Some("HEARTBEAT"),
            Some(&[json!({ "tool": "shell_exec" })]),
            Some(&FormatSlackMessageOptions {
                feedback_message_id: Some("m-1".into()),
            }),
        );
        assert_eq!(
            serde_json::to_string(&message.blocks).unwrap(),
            r#"[{"type":"context","elements":[{"type":"mrkdwn","text":"💓 Heartbeat Alert"}]},{"type":"markdown","text":"hello"},{"type":"context","elements":[{"type":"mrkdwn","text":"🔧 shell_exec"}]},{"type":"actions","block_id":"lens_feedback","elements":[{"type":"button","action_id":"feedback_thumbs_up","text":{"type":"plain_text","text":"👍 Helpful","emoji":true},"value":"m-1"},{"type":"button","action_id":"feedback_thumbs_down","text":{"type":"plain_text","text":"👎 Not helpful","emoji":true},"value":"m-1"}]}]"#
        );
    }

    // slackChannelLabel

    #[test]
    fn names_the_channel_with_one_hash() {
        assert!(slack_channel_label("alerts").contains("the team Slack channel **#alerts**,"));
        assert!(slack_channel_label("#general").contains("the team Slack channel **#general**,"));
    }

    #[test]
    fn tells_the_agent_to_mention_someone_with_their_token() {
        assert!(slack_channel_label("alerts").contains("writing their token"));
    }
}
