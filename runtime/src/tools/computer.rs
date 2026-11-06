//! The computer tools: the ones `create_computer_tools` builds, dispatched to the
//! computer each call names (or the run's default), plus `computer_screen`,
//! `computer_help`, `computer_continue` and, in a voice call,
//! `computer_instruct`.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;
use crate::services::computer::agent_computer::ModelChannel;
use crate::services::computer::computer_access::ComputerUse;

pub const ALERT_THE_USER: &str = "The user may not be watching this conversation. If you have a notification tool for alerting them, call it now; do not message them through another service.";
pub const ANOTHER_INVOCATION: &str = "Another invocation is using the computer. Use computer_screen to discuss it, or computer_instruct to relay the user’s instructions.";
pub const COMPUTER_SCREEN_DESCRIPTION: &str = "Inspect your current desktop and browser. Inspect it again after navigation or user help. During human takeover, set userRequested only when the user explicitly asks you to inspect the screen. Automatic inspection waits for hand-back. While the user completes a help request, every inspection waits for hand-back.";
/// The literal parts of the `computer_help` description, around: `use && waitsForAnswer(use.mode) ? `This call waits up to ${WAIT_MINUTES} minutes for the user's answer, so do independent work first.` : 'Continue independent tasks; when only blocked work remains, end this turn and wait for the user.'`.
pub const COMPUTER_HELP_DESCRIPTION_PARTS: [&str; 1] = [
    "When computer work is blocked by a step only the user can complete, ask them for help, such as signing in, solving a CAPTCHA, or approving a device. Call it immediately; do not wait for the user to ask you to request help, and pass tab for the tab that needs help. Set credentials for any sign-in screen — one asking for a username and a password, for the username alone, or for the password alone — and the user is asked for their username and password where they are, and the runtime types both in, screen by screen. Never ask for either in chat, never offer to try one, and never report the sign-in and stop for instructions: make the call. A CAPTCHA, a device approval, or a second factor leaves credentials false. Preserves this help request and releases the computer for independent work. Explain what the user needs to do. ",
];
pub const COMPUTER_CONTINUE_DESCRIPTION: &str = "Resolve a computer help request after the user explicitly says they finished helping, or dismiss it at their request. Then inspect the screen before continuing. The commands you started are paused while the user takes over the computer to help, so also check whatever you left running. Use the help ID from computer_help.";
pub const COMPUTER_INSTRUCT_DESCRIPTION: &str = "Relay your user’s spoken instructions to the chat invocation currently using the computer. Use this instead of competing with it for input. The instructions appear in that conversation.";

/// `HELP_ANSWER_WAIT_MS` in minutes, as JavaScript writes the number.
fn wait_minutes() -> String {
    todo!()
}

/// What a run that waited for its help request is told, by answer
/// (`continued`, `dismissed`, `unanswered`).
pub fn help_answer_text(answer: &str) -> String {
    match answer {
        "continued" => "The user finished helping. Inspect the screen, then continue the work. If something else blocks it, ask for that help now.".to_string(),
        "dismissed" => "The user dismissed the help request. Finish without the blocked work, and say in your reply what it left undone.".to_string(),
        _ => format!(
            "The user did not answer within {} minutes, and the request stays open. Finish without the blocked work, and say in your reply what is still blocked.",
            wait_minutes()
        ),
    }
}

/// The `computer_help` description. `waits` is whether the run waits for the
/// answer (`waits_for_answer(mode)` with an active invocation).
pub fn computer_help_description(waits: bool) -> String {
    let [head] = COMPUTER_HELP_DESCRIPTION_PARTS;
    if waits {
        format!(
            "{head}This call waits up to {} minutes for the user's answer, so do independent work first.",
            wait_minutes()
        )
    } else {
        format!(
            "{head}Continue independent tasks; when only blocked work remains, end this turn and wait for the user."
        )
    }
}

/// The voice channel of the call these tools serve, when there is one.
pub type VoiceChannel = Arc<dyn Fn() -> Option<Arc<dyn ModelChannel>> + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenInput {
    #[serde(default)]
    pub user_requested: bool,
    /// The computer to use, offered while remote computers exist.
    #[serde(default)]
    pub computer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComputerHelpInput {
    pub reason: String,
    #[serde(default)]
    pub tab: Option<i64>,
    #[serde(default)]
    pub credentials: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerContinueInput {
    pub help_id: String,
    #[serde(default)]
    pub dismiss: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComputerInstructInput {
    pub instruction: String,
}

/// The `computer_screen` schema; `named` adds the `computer` field.
pub fn computer_screen_input_schema(named: bool) -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn computer_help_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn computer_continue_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn computer_instruct_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// Schemas stay fixed for a mode and for the set of computers; the calling
/// invocation supplies its ownership and image sink. A run that may use a remote
/// computer names it in each call's `computer` once one exists. `mode` is the
/// invocation's (`computer_use.mode` when `None`), and a request that has none,
/// such as a compaction, passes the mode whose tools block it repeats.
///
/// Each base tool runs on the computer its call names, with the images it shows
/// returned beside its text in the model output (`render_tool_result` of the
/// output, then each image's data and media type from its data URL). A voice
/// call that finds the computer in another invocation's hands is told
/// `ANOTHER_INVOCATION`. `computer_browse` is left out for a run that names
/// remote computers on a runtime with no computer of its own.
pub fn get_computer_tools(
    computer_use: Option<Arc<ComputerUse>>,
    voice_channel: Option<VoiceChannel>,
    mode: Option<&str>,
) -> ToolSet {
    todo!()
}
