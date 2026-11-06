//! The session instructions for a live voice session: the agent's own system prompt,
//! plus how to behave in a call.
//!
//! Same pipeline `invoke()` uses, so Soul, User, Agent Guide, Memory and Skills all carry
//! over — that is what makes the voice the agent rather than a generic assistant wearing
//! its name. A voice chat opens with the end of the text conversation it continues, in
//! words only, since the session pays per token. What the agent recorded in the hours
//! before the call follows it, so a call picks up where the last conversation stopped.
//!
//! Every session owner builds its instructions here, so a meeting and a voice chat differ
//! in what they pass and nowhere else.

use crate::services::meeting::response_policy::ResponseMode;

/// The desktop around a computer a voice chat opened, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopSize {
    pub width: i64,
    pub height: i64,
}

/// The computer a voice chat opened, and the desktop around it where there is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceCallComputer {
    pub desktop: Option<DesktopSize>,
}

/// Which call the prompt describes.
///
/// A meeting is a room on a platform. A voice chat is the agent and one client, and what
/// that client gave it decides what its prompt says it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceCall {
    Meeting {
        platform: String,
    },
    VoiceChat {
        /// The computer the session opened, and the desktop around it where there is one.
        computer: Option<VoiceCallComputer>,
        /// Whether this client can share its own screen with the agent.
        user_screen: bool,
        /// The conversation the call continues, already resolved for the thread mode.
        thread_id: Option<String>,
        /// Whether the call's summary is stored in that conversation when it ends.
        summarized: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceInstructionsInput {
    pub user_id: String,
    pub agent_id: String,
    pub call: VoiceCall,
    pub response_mode: ResponseMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceInstructions {
    pub instructions: String,
    /// The name the prompt introduces the agent by, handed back so the caller can give the
    /// same one to the gate that decides whether the agent was called — the room hears this
    /// one, so it is the one people will actually say.
    pub agent_name: String,
    /// From the same context, so the tool set matches the prompt built beside it.
    pub locked_in: bool,
    /// The end of the conversation a voice chat continues, then what the agent recorded
    /// shortly before the call, each fenced, or `None` when there is neither. Both hold text
    /// from outside the prompt, so the session receives them as a user item and never as
    /// instructions.
    pub opening_context: Option<String>,
}

/// Build the instructions for one voice session.
///
/// The agent context is read without its conversation, so the recent memories are always
/// offered. The system prompt parts are built in `meeting` mode and joined with
/// `\n\n---\n\n`, then the call's own instructions follow after the same separator: the
/// meeting prompt for a meeting, the voice chat prompt for a voice chat. A voice chat is
/// never `auto` — that mode resolves from a participant count, and one mixed microphone
/// yields none — so anything but `addressed` is `open` there. The opening context is the
/// conversation's history (a voice chat with a thread only) followed by the recent
/// memories, concatenated with no separator.
pub async fn build_voice_instructions(
    input: VoiceInstructionsInput,
) -> anyhow::Result<VoiceInstructions> {
    todo!()
}

/// The end of the conversation a voice chat continues, in words only. Its history is
/// readable only when the thread's source is the database.
async fn conversation_history(thread_id: &str) -> anyhow::Result<Option<String>> {
    todo!()
}
