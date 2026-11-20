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

use crate::db::models::ThreadSource;
use crate::prompts::context_builder::{
    ConversationMessage, PromptMode, build_recent_memories, build_system_prompt_parts,
    recent_memory_content,
};
use crate::prompts::meeting_prompt::{MeetingInstructionsInput, get_meeting_instructions};
use crate::prompts::voice_chat_prompt::{
    DesktopSize as PromptDesktopSize, VoiceChatInstructionsInput, VoiceComputer,
    get_voice_chat_instructions,
};
use crate::prompts::voice_delivery_prompt::ResponseMode as PromptResponseMode;
use crate::prompts::voice_history::{VoiceHistoryInput, voice_history_content};
use crate::services::context_service::{AgentContextOptions, CONTEXT_SERVICE};
use crate::services::conversation_service::CONVERSATION_SERVICE;
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
    let context = CONTEXT_SERVICE
        .get_agent_context(
            &input.user_id,
            AgentContextOptions {
                agent_id: input.agent_id.clone(),
                thread_id: None,
                include_conversation: Some(false),
                verbose: None,
            },
        )
        .await?;
    let parts = build_system_prompt_parts(&context, PromptMode::Meeting, None, None).await?;
    // The context holds no conversation, so the recent memories are always offered.
    let recent = build_recent_memories(&context).await?;
    let call = match &input.call {
        VoiceCall::Meeting { platform } => get_meeting_instructions(&MeetingInstructionsInput {
            agent_name: context.agent_name.clone(),
            platform: platform.clone(),
            response_mode: prompt_mode(input.response_mode),
        }),
        VoiceCall::VoiceChat {
            computer,
            user_screen,
            thread_id,
            summarized,
        } => get_voice_chat_instructions(&VoiceChatInstructionsInput {
            agent_name: context.agent_name.clone(),
            // A voice chat is never `auto`: that mode resolves from a participant count,
            // and one mixed microphone yields none.
            response_mode: if input.response_mode == ResponseMode::Addressed {
                PromptResponseMode::Addressed
            } else {
                PromptResponseMode::Open
            },
            computer: computer.map(|computer| VoiceComputer {
                desktop: computer.desktop.map(|desktop| PromptDesktopSize {
                    width: desktop.width,
                    height: desktop.height,
                }),
            }),
            user_screen: *user_screen,
            conversation: thread_id.is_some(),
            summary: *summarized,
        }),
    };
    let history = match &input.call {
        VoiceCall::VoiceChat {
            thread_id: Some(thread_id),
            ..
        } if !thread_id.is_empty() => conversation_history(thread_id).await?,
        _ => None,
    };
    let opening: Vec<String> = [
        history,
        recent.map(|recent| recent_memory_content(&recent.text)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let prompt = parts
        .iter()
        .map(|part| part.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    Ok(VoiceInstructions {
        instructions: [prompt, call].join("\n\n---\n\n"),
        agent_name: context.agent_name.clone(),
        locked_in: context.locked_in,
        opening_context: if opening.is_empty() {
            None
        } else {
            Some(opening.concat())
        },
    })
}

/// The end of the conversation a voice chat continues, in words only. Its history is
/// readable only when the thread's source is the database.
async fn conversation_history(thread_id: &str) -> anyhow::Result<Option<String>> {
    let thread = CONVERSATION_SERVICE.get_thread_context(thread_id).await?;
    Ok(voice_history_content(&VoiceHistoryInput {
        compaction_summary: thread.compaction_summary,
        messages: thread
            .messages
            .into_iter()
            .map(ConversationMessage::from_row)
            .collect(),
        history_readable: thread.thread_source == ThreadSource::Database,
    }))
}

/// The policy's response mode as the prompts name it.
fn prompt_mode(mode: ResponseMode) -> PromptResponseMode {
    match mode {
        ResponseMode::Auto => PromptResponseMode::Auto,
        ResponseMode::Open => PromptResponseMode::Open,
        ResponseMode::Addressed => PromptResponseMode::Addressed,
    }
}
