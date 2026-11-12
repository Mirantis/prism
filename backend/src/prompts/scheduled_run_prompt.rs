//! The user message of a scheduled run that continues no conversation.

use crate::types::TaskLastSend;

/// The user message of a scheduled run that continues no conversation: the
/// task's instruction, then a reminder that only a post reaches anyone. An
/// instruction written as steps that end in "reply with X" reads as a request
/// for a final message, and its words about the text ("exactly", "nothing
/// else") as a rule for the final message. The reminder sits right after it and
/// ties those words to the post. A run that has a send record is also told to
/// read it first, because a conditional finding that holds on every run reads as
/// a request for a post on every run.
pub fn scheduled_run_prompt(instruction: &str, last_send: Option<&TaskLastSend>) -> String {
    let record = if last_send.is_some() {
        " Before you post, read \"Messages This Task Sent\"."
    } else {
        ""
    };
    format!(
        "{instruction}\n\n(Scheduled run: only what you post with send_message reaches anyone. A reply, a report or a message the instruction asks for is a post, and words such as \"exactly\" or \"nothing else\" set the text of that post.{record})"
    )
}
