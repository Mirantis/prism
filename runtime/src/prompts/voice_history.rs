//! The text conversation a voice call continues, as the user item that opens the call.
//!
//! Only the words are sent: a call pays per token and speaks, so tool calls and their
//! results stay in the thread. The newest messages are kept, each one cut, so the item
//! stays at a few thousand tokens however long the thread is.

use crate::db::models::MessageRole;
use crate::prompts::context_builder::{ConversationMessage, break_tag};
use crate::support::js::{len16, slice16};
use crate::tools::conversation_history::COMPACTED_HISTORY_TOOL_NAME;

const TAG: &str = "conversation-so-far";

/// Messages from the end of the thread. With the cut below, about 5,000 tokens at most.
pub const VOICE_HISTORY_MESSAGES: usize = 20;

/// Each message is cut to this many characters, from its start.
pub const VOICE_HISTORY_MESSAGE_CHARS: usize = 1_000;

/// The compaction summary is cut to this many characters, from its end, which is the newest part.
pub const VOICE_HISTORY_SUMMARY_CHARS: usize = 8_000;

#[derive(Debug, Clone, PartialEq)]
pub struct VoiceHistoryInput {
    pub compaction_summary: Option<String>,
    pub messages: Vec<ConversationMessage>,
    /// Whether `read_compacted_history` can read this thread's compacted messages.
    pub history_readable: bool,
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// The fenced block, or `None` when the thread holds nothing to continue.
pub fn voice_history_content(input: &VoiceHistoryInput) -> Option<String> {
    let kept: Vec<&ConversationMessage> = input
        .messages
        .iter()
        .filter(|m| {
            !m.internal_step && m.role != MessageRole::System && !js_trim(&m.content).is_empty()
        })
        .collect();
    let lines: Vec<String> = kept[kept.len().saturating_sub(VOICE_HISTORY_MESSAGES)..]
        .iter()
        .map(|m| {
            let who = if m.role == MessageRole::User {
                "User"
            } else {
                "Agent"
            };
            format!(
                "{who}: {}",
                cut_end(js_trim(&m.content), VOICE_HISTORY_MESSAGE_CHARS)
            )
        })
        .collect();
    let summary = input
        .compaction_summary
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty());
    if lines.is_empty() && summary.is_none() {
        return None;
    }

    let lookup = if summary.is_some() && input.history_readable {
        format!(" {COMPACTED_HISTORY_TOOL_NAME} reads the summarized messages word for word.")
    } else {
        String::new()
    };
    let body = [
        summary.map(|summary| {
            format!(
                "Earlier, summarized:\n{}",
                cut_start(summary, VOICE_HISTORY_SUMMARY_CHARS)
            )
        }),
        (!lines.is_empty()).then(|| lines.join("\n\n")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    Some(format!(
        "<{TAG}>\nYour text conversation with your user before this call, newest last.{lookup}\n\n{}\n</{TAG}>",
        break_tag(&body, TAG)
    ))
}

fn cut_end(text: &str, max: usize) -> String {
    if len16(text) <= max {
        text.to_string()
    } else {
        format!("{}…", slice16(text, 0, max))
    }
}

fn cut_start(text: &str, max: usize) -> String {
    let length = len16(text);
    if length <= max {
        text.to_string()
    } else {
        format!("…{}", slice16(text, length - max, length))
    }
}
