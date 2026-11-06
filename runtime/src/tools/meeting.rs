//! Tools for a live voice meeting: joining it, leaving it, the agent's own microphone, and
//! what is happening in the room.
//!
//! All of them are platform-agnostic. The platform is decided by the URL
//! (`find_provider` matches on the host), so one join and one leave serve every
//! platform; the supported platforms belong in the description, which is read at
//! the same moment as the name and can say more.
//!
//! Registered only when the container can actually host a call — the browser and
//! audio toolchain on PATH plus an OpenAI key. Offering a tool that always answers
//! "not available here" wastes tokens on every turn and invites the model to promise
//! something it can't do.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::ToolSet;

pub const MEETING_READ_TOOL_NAME: &str = "read_meeting_chat";
pub const JOIN_MEETING_DESCRIPTION: &str = "Join a video call as a live voice participant — you will speak and listen in real time. Google Meet links are supported today; the platform is taken from the URL. Returns once the request to join is in, or once the attempt has failed, which it names a step for; a host still has to admit you, so call meeting_status to find out whether you got in. Only one call at a time.";
pub const LEAVE_MEETING_DESCRIPTION: &str = "Leave the call you are currently in, whichever platform it is on. There is only ever one, so this needs no arguments.";
pub const SET_MICROPHONE_DESCRIPTION: &str = "Turn your own microphone on or off in the call you are in. Off means the participants cannot hear you at all; on uncovers it at the platform, and the reply says whether the room can actually hear you. Use it when somebody asks you to mute, and to turn yourself back on afterwards — you stay muted until you do. It reports the state it read back, so a reply saying the microphone still reads muted means the click did not take and nobody is hearing you.";
pub const SHARE_SCREEN_DESCRIPTION: &str = "Start sharing your screen in the call you are in, so the room can see it. Use this tool to show something in the browser or demonstrate UI features of an application. What they see is the whole screen your browser runs on, so open the page with `browse` first — whatever is in front is what shows. It takes several seconds. Stop it with `stop_screen_share`.";
pub const STOP_SCREEN_SHARE_DESCRIPTION: &str = "Stop sharing your screen, staying in the call. Says so plainly when you were not sharing anything.";
pub const BROWSE_DESCRIPTION: &str = "Use a web browser: open a page, click things, type, scroll, and work in several tabs. It runs beside the meeting, on the same screen `share_screen` presents — so this is how you put something in front of the room, and how you look something up on the web in a call. To only read a page you have the address of, web_fetch is faster. Every command answers with where the page is, what it says, the names of the links, buttons and fields on it, and the list of open tabs. Click and type by those names, and switch tabs by those numbers. One command per call, and only while you are in a meeting.";
pub const SEE_SCREEN_DESCRIPTION: &str = "See what your screen is showing right now — a picture of it, plus the text and controls of the page. This is the same screen the room sees while you are sharing, so use it to check that what you meant to show is up, to find your way around a page `browse` reported oddly, or to answer a question about what is on screen. Takes a couple of seconds.";
pub const MEETING_SPEAKER_DESCRIPTION: &str = "Find out who is speaking in the call, and who said the thing you are answering. The meeting audio reaches you as one mixed channel with no speaker labels, so this is the only way you can know — but the runtime reads it off the platform, so it is instant and costs nothing. Use it when a name matters: who asked you something, who to answer, who is in the room. It tells you plainly when it cannot say, and when the voice was a group of people sharing one microphone rather than one person.";
/// The literal parts of the `send_meeting_chat` description, around: `MEETING_CHAT_MAX_CHARS`.
pub const SEND_MEETING_CHAT_DESCRIPTION_PARTS: [&str; 6] = [
    "Post one short plain-text message into the chat of the call you are in. Use it for what speech mangles: a link, an id, a command to paste. Say the rest out loud — ",
    "speech is how you talk to the room. At most ",
    " characters, no ",
    "formatting and no line breaks. It needs a live call: with none there is nothing to ",
    "post into, and it tells you so instead of sending. If it fails, say the content out ",
    "loud instead of trying again.",
];
/// The literal parts of the `read_meeting_chat` description, around: `MEETING_CHAT_READ_LIMIT`, `MEETING_CHAT_CUT_MARK.trim()`.
pub const READ_MEETING_CHAT_DESCRIPTION_PARTS: [&str; 6] = [
    "Read the messages people have typed in the chat of the call you are in. Use it when somebody asks you to look at the chat, or says they have pasted something there. Nothing tells you a message arrived, so this is the only way to see one. It shows ",
    "at most the newest ",
    " messages, oldest first, each with the ",
    "name the call shows for whoever sent it. A message too long to show whole ends with ",
    "",
    ", so you can say that you have only part of it.",
];
pub const MEETING_STATUS_DESCRIPTION: &str = "Check whether you are in a call and how it is going, whichever platform it is on: state, which platform, how long, how many times you have spoken or used a tool, whether you are currently answering everything or only when addressed, and whether the room can hear you. `isMicLive` is true when it can, false when it cannot, and null when the runtime could not read your microphone at all — worth checking before you take silence from the room to mean nobody is there.";

/// The two that change which call the agent is in, so every autonomous mode can
/// drop them in one place.
///
/// Only a person in a conversation decides that an agent joins a call or leaves one. A
/// heartbeat, a cron tick or a subagent dialling into a live call with people in it — or
/// hanging up on one — is never what the operator asked for.
///
/// Every mode keeps the status reads, the microphone and the chat send. Asking "am I in a
/// call?" costs nothing, a microphone with no call answers that it has none, and a scheduled
/// run that reports back into the room is why the send is reachable outside a call in the
/// first place. The screen tools and the chat read go too, each for the reason below.
pub const MEETING_MEMBERSHIP_TOOL_NAMES: [&str; 2] = ["join_meeting", "leave_meeting"];

/// The tools that act on the call's screen, dropped by the same modes and for the same
/// reason: what the room is watching is not for an autonomous run to move.
pub const MEETING_SCREEN_TOOL_NAMES: [&str; 4] =
    ["share_screen", "stop_screen_share", "browse", "see_screen"];

/// Every tool here, which is what a voice chat drops.
///
/// A voice chat is a call between the agent and one client, not a room: it has no
/// participants to name, no chat panel to post into, and its microphone is the client's
/// own to mute. Each of these would answer that there is no call to act on, so declaring
/// them costs tokens and invites the model to offer what it cannot do.
pub const MEETING_TOOL_NAMES: [&str; 10] = [
    "join_meeting",
    "leave_meeting",
    "share_screen",
    "stop_screen_share",
    "browse",
    "see_screen",
    "set_microphone",
    "meeting_speaker",
    "send_meeting_chat",
    "meeting_status",
];

/// The `send_meeting_chat` description, naming `MEETING_CHAT_MAX_CHARS`.
pub fn send_meeting_chat_description() -> String {
    todo!()
}

/// The `send_meeting_chat` description for a chat message limit.
pub fn send_meeting_chat_description_for(max_chars: usize) -> String {
    let [p0, p1, p2, p3, p4, p5] = SEND_MEETING_CHAT_DESCRIPTION_PARTS;
    format!("{p0}{p1}{max_chars}{p2}{p3}{p4}{p5}")
}

/// The `read_meeting_chat` description, naming `MEETING_CHAT_READ_LIMIT` and the
/// trimmed `MEETING_CHAT_CUT_MARK`.
pub fn read_meeting_chat_description() -> String {
    todo!()
}

/// The `read_meeting_chat` description for a read limit and a trimmed cut mark.
pub fn read_meeting_chat_description_for(read_limit: usize, cut_mark: &str) -> String {
    let [p0, p1, p2, p3, p4, p5] = READ_MEETING_CHAT_DESCRIPTION_PARTS;
    format!("{p0}{p1}{read_limit}{p2}{p3}{p4}{cut_mark}{p5}")
}

#[derive(Debug, Clone, Default)]
pub struct MeetingToolsInput {
    pub user_id: String,
    pub agent_id: String,
    /// The calling turn's thread.
    pub thread_id: Option<String>,
    /// Whether these tools are being built for the meeting's own model.
    ///
    /// Only `see_screen` reads it, and only because the picture it takes can be
    /// delivered to the model in the call and to nobody else. A chat turn that calls
    /// it during a live call gets the page in words instead.
    pub in_meeting_session: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JoinResponseMode {
    Auto,
    Open,
    Addressed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinMeetingInput {
    /// The meeting link.
    pub url: String,
    /// How much you speak up (default `auto`).
    #[serde(default)]
    pub response_mode: Option<JoinResponseMode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetMicrophoneInput {
    /// true turns the microphone on, false turns it off.
    pub on: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowseAction {
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

/// One browser command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseInput {
    pub action: BrowseAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendMeetingChatInput {
    /// The message, as plain text on one line.
    pub text: String,
}

pub fn join_meeting_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn set_microphone_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn browse_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn send_meeting_chat_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// `{}`, the schema of every tool here that takes no input.
pub fn empty_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// Whether this host can run a voice meeting: Realtime configured, a browser,
/// and every audio-stack binary on PATH (`[Meeting] Voice meetings unavailable:
/// <binary> is not on PATH` otherwise).
///
/// Checked once at startup rather than per turn, so the tool set stays
/// byte-identical across requests — the provider's prompt cache covers the tools
/// block, and a set that changes shape mid-conversation misses it.
pub async fn is_meeting_supported() -> bool {
    todo!()
}

/// join_meeting, leave_meeting, set_microphone, share_screen,
/// stop_screen_share, browse, see_screen, meeting_speaker, send_meeting_chat,
/// read_meeting_chat, meeting_status.
pub fn get_meeting_tools(input: MeetingToolsInput) -> ToolSet {
    todo!()
}
