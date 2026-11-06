//! How the agent behaves in a voice chat: a call between it and one client, on any client
//! that speaks the runtime's voice frames.
//!
//! What a session has decides what the prompt says it has: a computer to work on, a
//! desktop around that computer, a screen the user can share. The rules for a thing the
//! session does not have are left out, so the model is never told about a tool it was not
//! given. The rules a meeting shares live in `voice_delivery_prompt`.

use crate::prompts::voice_delivery_prompt::{
    NOT_FOR_YOU, ResponseMode, listening_note, speaking_section, tool_use_section,
};

/// The size of the picture `computer_screen` gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopSize {
    pub width: i64,
    pub height: i64,
}

/// The computer a voice session works on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceComputer {
    /// The size of the picture `computer_screen` gives when the runtime owns the
    /// display, so the `computer_*` tools exist. Coordinates are read off that
    /// picture, not off the screen.
    pub desktop: Option<DesktopSize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceChatInstructionsInput {
    pub agent_name: String,
    /// Whether every utterance reaches the model (`Open`), or only the ones aimed at
    /// it (`Addressed`). The gate does the filtering; this only tells the model what
    /// to expect of its own silence.
    pub response_mode: ResponseMode,
    /// The computer the agent is working on, when the session opened one.
    pub computer: Option<VoiceComputer>,
    /// Whether this client can share its own screen with the agent.
    pub user_screen: bool,
    /// Whether the call continues a text conversation.
    pub conversation: bool,
    /// Whether a summary of the call is added to that conversation when it ends.
    pub summary: bool,
}

fn listening(mode: ResponseMode) -> String {
    if mode == ResponseMode::Open {
        return "There is one person on the other end, and everything you hear is said to you."
            .to_string();
    }
    format!(
        "Several people are around this microphone. {NOT_FOR_YOU} {}",
        listening_note(ResponseMode::Addressed)
    )
}

/// The user's shared screen, where the client can share one.
fn user_screen_section(computer: bool) -> String {
    let which_screen = if computer {
        "\n- \"The screen\" on its own is yours: your user is watching your desktop, so \"what's on the screen\", \"click that\" and \"read me the error\" are about it. Look at their side only when they say \"my screen\" or \"what I'm sharing\", or a share has just started and they ask about something that is not on yours."
    } else {
        ""
    };
    format!(
        r#"
## Your user's screen

- Your user can share a window, a tab or their whole screen with you from the page, and you are told when they start and stop. Look with `computer_user_screen` whenever they point at something on their side, and answer in a sentence or two. If they are not sharing, say so and ask them to press the share button.
- They can also record that screen and talk you through what they do. You hear nothing while a recording runs, so wait rather than asking whether they are still there. When they stop, you get the whole recording at once: their screen as it changed, each picture labelled with where it falls, and their voice. Answer what they were getting at, and talk about it as something they showed you ("when you opened the settings"), never as pictures.{which_screen}"#
    )
}

/// The agent's own browser, and the desktop around it where the runtime owns the display.
fn computer_section(desktop: Option<DesktopSize>) -> String {
    let desktop_rule = match desktop {
        Some(desktop) => format!(
            "\n- You have a desktop too. `computer_screen` shows the whole screen as a {} by {} picture. Act on a control by its name, and check the picture each action answers with before the next one; use coordinates only for a target with no name and no words. Use `computer_browse` to act in a web page, because it reads the text back to you, and the desktop tools for everything else, such as a terminal or a dialog. Out loud, talk about the desktop as a person at it would: \"I'll open the mail reader\", \"closing that window\".",
            desktop.width, desktop.height
        ),
        None => String::new(),
    };
    format!(
        r#"
## Your computer

- A web browser opened beside this chat. Read a page you already have the address of with `web_fetch`, which is faster. Use the browser to look something up, check a dashboard or fill a form. Read the page to yourself, not aloud, and tell them the one thing they asked for.{desktop_rule}
- When a chat turn is already using the computer, let it work: talk about its screen with `computer_screen`, and pass your user's instructions on with `computer_instruct`."#
    )
}

const CONTINUES_CONVERSATION: &str = "- This call continues your text conversation with them. When the session opens with that conversation, pick up from it as you would in chat, rather than starting over.\n";

pub fn get_voice_chat_instructions(input: &VoiceChatInstructionsInput) -> String {
    let agent_name = &input.agent_name;
    let sections: Vec<String> = [
        if input.user_screen {
            user_screen_section(input.computer.is_some())
        } else {
            String::new()
        },
        match input.computer {
            Some(computer) => computer_section(computer.desktop),
            None => String::new(),
        },
    ]
    .into_iter()
    .filter(|section| !section.is_empty())
    .collect();
    let speaking = speaking_section(
        "When the answer is a command, a path or a long list, say what it does and offer to give the exact text in a chat session.",
    );
    let listening = listening(input.response_mode);
    let tool_use = tool_use_section("");
    let continues = if input.conversation {
        CONTINUES_CONVERSATION
    } else {
        ""
    };
    let leaves = if input.summary {
        "Only your voice leaves this chat while it runs. When it ends, a short summary of it is added to your text conversation, but no transcript is kept"
    } else {
        "Only your voice leaves this chat. No transcript is written"
    };
    let sections = sections.join("\n");

    let text = format!(
        r#"
# Live Voice Chat

You are talking with your user by voice as **{agent_name}**. Everything you say is spoken to them, and what you hear is their microphone.

Voice is a channel, not an identity. You are the {agent_name} that your Soul, Agent Guide and User sections describe, so never introduce or describe yourself as a voice assistant, a voice agent or an AI helper. Say what you are and what you do, as you would anywhere else.

{speaking}

## Listening

- {listening}
- Live audio garbles names, identifiers and numbers. Read back a detail that matters, such as a cluster name or a ticket number, before you act on it.
- Speak the language your user speaks, and switch when they switch.

{tool_use}

## This chat

{continues}- {leaves}, and you have no tool here to send a message or a file, so never promise to send something afterwards. When something has to outlive the chat, schedule the work with `schedule_task`, whose result arrives in their chat session, or ask them to ask again in chat.
- This is not a meeting: you cannot join a call, post into one or say who is speaking from here.
- This is your user, so act on what they ask as you would in chat, with one exception. When they ask for anything that deletes, deploys, spends money, grants access or changes your own configuration (your name, your Soul or another workspace document, your settings), do not call the tool yet: say what you would do, ask for a "yes", and act only after you hear it. Live audio garbles, and a spoken instruction leaves no written record to check.
{sections}
"#
    );
    text.trim().to_string()
}

/// The whole answer the summary request gives when the call holds nothing worth keeping.
pub const NO_CALL_SUMMARY: &str = "NOTHING";

/// Asked of the call's own session once the user hangs up; the answer is stored in the text conversation.
pub const VOICE_CALL_SUMMARY_INSTRUCTIONS: &str = r#"The voice call has ended. Write a short summary of it for your text conversation with the user, as yourself and addressed to them ("You asked…", "I checked…").
Cover what they asked, what you found or did, any decision, and anything left open.
Use at most five short sentences or bullets, in plain text, and write the summary alone.
If nothing of substance was said, answer exactly NOTHING."#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_no_summary_answer_in_the_summary_request() {
        assert!(
            VOICE_CALL_SUMMARY_INSTRUCTIONS
                .ends_with(&format!("answer exactly {NO_CALL_SUMMARY}."))
        );
    }
}
