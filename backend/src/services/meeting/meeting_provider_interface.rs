//! The extension seam for meeting platforms.
//!
//! Almost nothing about a voice meeting is Google-specific: the virtual audio
//! devices, the Realtime session, barge-in and the tool bridge are all the same
//! whether the call is on Meet, Teams or Zoom. What differs is a browser flow —
//! which buttons to press to get in, how to tell you were admitted, how to know
//! the room emptied, and how to leave.
//!
//! A provider therefore owns exactly that and nothing else. Adding Teams means
//! writing one of these, registering it, and adding a `join_msteams_meeting` tool;
//! no part of the audio or model path needs to know a second platform exists.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::services::meeting::browser_stack::PageHandle;

/// Where a join attempt got to before it stopped.
///
/// A bounded enum rather than the prose reason, because it is emitted as telemetry:
/// it answers "which step is failing in production" without carrying page text. The
/// `reason` stays the thing a human reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinStep {
    PageLoad,
    Lobby,
    JoinButton,
    Admission,
    Microphone,
}

impl JoinStep {
    pub fn as_str(self) -> &'static str {
        match self {
            JoinStep::PageLoad => "page_load",
            JoinStep::Lobby => "lobby",
            JoinStep::JoinButton => "join_button",
            JoinStep::Admission => "admission",
            JoinStep::Microphone => "microphone",
        }
    }
}

/// Outcome of trying to get into a call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum JoinOutcome {
    /// In the room — audio flows from here, in at least one direction.
    #[serde(rename_all = "camelCase")]
    Admitted {
        /// Whether the platform had us muted on arrival, before the provider unmuted.
        ///
        /// Carried on the outcome rather than read back afterwards because it is a
        /// fact about the join that stops being observable the moment it is fixed.
        /// Emitted as telemetry: how often a platform auto-mutes new joiners is what
        /// says whether this whole step still earns its keep, and it is the number
        /// whose absence let a permanently silent bot go unnoticed.
        ///
        /// `false` when the control could not be read at all — a reading nobody took
        /// is not evidence of an auto-mute, and counting it would inflate the number
        /// during precisely the outage that produces it.
        muted_on_entry: bool,
        /// Whether the room can actually hear us.
        ///
        /// Separate from `status` on purpose, and the distinction matters: an agent
        /// that cannot speak still hears the meeting and keeps its whole tool surface,
        /// so being inaudible is a degraded call rather than a failed one. The runtime
        /// says so — to the user, and to the model, which would otherwise spend the
        /// call talking to a room that hears nothing.
        mic_confirmed: bool,
    },
    /// A host actively refused, or the waiting room timed out.
    Denied { reason: String, step: JoinStep },
    /// Never got as far as the waiting room (bad link, meeting over, UI changed).
    Failed { reason: String, step: JoinStep },
    /// The credentials we hold were not accepted, and signing in again may fix it.
    ///
    /// Platform-neutral by intent — an expired SSO session on Teams is the same shape.
    ///
    /// Worth its own outcome because it is the one failure that heals itself: sign in
    /// again and the same link works. Previously the join went ahead as an anonymous
    /// guest, which Meet auto-denies — so a recoverable stale cookie cost a page load,
    /// a lobby wait and a refusal, and only recovered if the agent happened to try
    /// again. Observed three times in one afternoon on a profile whose own account
    /// page still loaded, so it is routine rather than exotic.
    ReauthRequired,
}

/// Who a voice belongs to, as far as the platform can say.
///
/// Two cases rather than one shape with optional fields, because they are answered
/// differently and a caller has to handle both. `Person` is somebody who can be named and
/// addressed. `Group` is one microphone several people share — any room system mixes the
/// people in front of it, and the platform can then only say that the group made a sound.
///
/// A group carries no name on purpose. The platform's label for it ("Merged audio" on
/// Meet) is a piece of its own UI and not somebody who can be spoken to, so an agent that
/// reads it out is talking to a person who does not exist. `members` is the useful answer
/// instead — best effort, and empty when the platform mixes people without saying which.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpeakerDetails {
    Person { name: String },
    Group { members: Vec<String> },
}

/// Who the platform last showed as speaking.
///
/// `id` is what callers compare, and never a name: two participants can share a display
/// name, a display name can change mid-call, and "was that the same person as before?" has
/// to be exact. On Meet it is the per-device path off the participants panel, and a merged
/// group's own identity is as sound as an individual's.
///
/// `is_self` is separate because "that was the agent" and "nobody can be identified" are
/// different answers, and a caller that folds them together keeps reporting a stale human
/// as the floor holder for the whole time the agent is talking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerReading {
    pub id: String,
    pub is_self: bool,
    pub who: SpeakerDetails,
}

/// Where a chat send got to before it stopped.
///
/// Bounded, for the same reason as `JoinStep`: it is emitted as telemetry, and the
/// message body must never be. `Panel` is no chat control on the page, `Composer` is
/// a panel that painted no input, `Send` is an input nothing will submit, and
/// `Confirm` is a submit the page never showed as sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSendStep {
    Panel,
    Composer,
    Send,
    Confirm,
}

impl ChatSendStep {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatSendStep::Panel => "panel",
            ChatSendStep::Composer => "composer",
            ChatSendStep::Send => "send",
            ChatSendStep::Confirm => "confirm",
        }
    }
}

/// Outcome of posting one message into the call's own chat.
///
/// `Sent` is a positive reading, never the absence of an error. A provider that
/// cannot tell whether the message left says `NotSent` — the room hearing nothing
/// while the agent reports success is the failure this shape exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatSendResult {
    Sent,
    /// `step` is what telemetry gets; `reason` is what a human reads in a log.
    NotSent {
        step: ChatSendStep,
        reason: String,
    },
}

/// Where a chat read stopped.
///
/// Bounded for the same reason as `ChatSendStep`: it is emitted as telemetry, and no
/// message body may ever be. `Panel` is no chat control on the page, `Composer` is a
/// panel that painted no input, and `Read` is a panel the reader could not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatReadStep {
    Panel,
    Composer,
    Read,
}

impl ChatReadStep {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatReadStep::Panel => "panel",
            ChatReadStep::Composer => "composer",
            ChatReadStep::Read => "read",
        }
    }
}

/// One message as the panel shows it.
///
/// `sender` is the name beside the message, and `None` when the panel shows none — the
/// agent's own messages, and a platform that names nobody. `truncated` says the reader cut
/// this message at the per-message bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessageRead {
    pub sender: Option<String>,
    pub text: String,
    pub truncated: bool,
}

/// Outcome of reading the messages already in the call's own chat.
///
/// `Read` with an empty list is a real answer — the panel opened and holds
/// nothing. A reader that cannot tell an empty panel from one it failed to parse says
/// `NotRead`, so a rotted selector never reports the chat as empty.
///
/// `truncated` says the panel held more messages than the caller asked for. A message the
/// reader cut is marked on the message itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatReadResult {
    Read {
        messages: Vec<ChatMessageRead>,
        truncated: bool,
    },
    /// `step` is what telemetry gets; `reason` is what a human reads in a log.
    NotRead { step: ChatReadStep, reason: String },
}

/// What became of a request to start or stop presenting.
///
/// One type for both directions. Both answer the same question: what the room sees now.
/// `AlreadySharing` and `NotSharing` are separate from `Sharing` and `Stopped` because
/// the agent says them differently. One announces a change, the other corrects somebody
/// about the state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ScreenShareOutcome {
    Sharing,
    AlreadySharing,
    Stopped,
    NotSharing,
    Failed { reason: String },
}

#[derive(Clone)]
pub struct JoinOptions {
    pub url: String,
    /// Cap on the waiting room, measured from the moment the join request goes in.
    ///
    /// Reaching the lobby is budgeted separately: charging page load and the join-button
    /// hunt to this number let a slow lobby report "nobody admitted the request" without
    /// the provider having waited even once.
    pub admission_timeout_ms: u64,

    /// Called once the request to join has gone in, before the wait for a host starts.
    ///
    /// The caller of a join answers a chat turn, and it can wait for the request but not
    /// for a host. This is the line between the two: everything before it — the page load,
    /// the lobby, the microphone, the join button — is reported to that caller as the
    /// failure it is, and everything after it is left to `status()`.
    ///
    /// Required rather than optional: a platform that never calls it holds the chat turn
    /// for the whole admission budget, which is the wait this exists to end.
    pub on_request_submitted: Arc<dyn Fn() + Send + Sync>,
}

/// Options for `MeetingProvider::sign_in`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SignInOptions {
    /// Skip any "am I already signed in?" probe.
    pub force: bool,
}

/// Bounds for `MeetingProvider::read_chat_messages`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatReadOptions {
    pub limit: usize,
    pub max_chars_per_message: usize,
}

/// Which of the optional operations a provider offers.
///
/// The service asks before it calls one, since "this platform has no such control" is an
/// answer it gives the model in words. Every flag defaults to `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProviderCapabilities {
    pub sign_in: bool,
    pub microphone_live: bool,
    pub set_microphone: bool,
    pub send_chat_message: bool,
    pub read_chat_messages: bool,
    pub participant_names: bool,
    pub enable_speaker_attribution: bool,
    pub current_speaker: bool,
    pub start_screen_share: bool,
    pub stop_screen_share: bool,
}

#[async_trait]
pub trait MeetingProvider: Send + Sync {
    /// Stable identifier, used in tool names, logs and telemetry.
    fn name(&self) -> &'static str;

    /// Human-readable platform name for messages to the user.
    fn display_name(&self) -> &'static str;

    /// The optional operations below that this provider offers.
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities::default()
    }

    /// Why this provider cannot run at all right now, or `None` when it can.
    ///
    /// Asked before a call's worth of infrastructure is built. Google Meet answers
    /// when no account is configured: it denies an automated anonymous guest before a
    /// host is ever prompted, so that join cannot succeed, and discovering it in the
    /// lobby costs a virtual display, an audio daemon, a browser and a metered
    /// Realtime socket first.
    ///
    /// The provider answers rather than the runtime because only it knows what it
    /// needs — the lifecycle owner should not be reading one platform's credentials.
    fn configuration_error(&self) -> Option<String>;

    /// Authenticate the browser profile, if the platform needs it.
    ///
    /// **Never fails.** A failed sign-in is non-fatal by design: whether the
    /// browser is signed in is decided by the profile's cookies, not by this call's
    /// opinion of them, and a check reporting a challenge for a session that then
    /// worked is something we have watched happen. Refusing a join on it would refuse
    /// joins that succeed.
    ///
    /// `force` skips any "am I already signed in?" probe. The caller passes it after a
    /// `ReauthRequired`, where that probe is precisely what was wrong.
    ///
    /// Optional: offered when `capabilities().sign_in` is set.
    async fn sign_in(&self, _page: &PageHandle, _options: SignInOptions) {}

    /// Whether this provider handles the given link.
    fn matches_url(&self, url: &str) -> bool;

    /// Drive the browser from a blank page into the meeting.
    ///
    /// Resolves with the outcome rather than failing for the expected endings
    /// (denied, timed out) — those are meeting facts to report to the user, not
    /// errors. An error is reserved for genuine breakage.
    ///
    /// **A platform that auto-mutes new joiners must unmute, and must say whether it
    /// worked.** Meet does this once a call is past a handful of participants. Getting
    /// in muted is not a failed join — the agent still hears the room and keeps every
    /// tool it has — but it is invisible from the inside, and that is the part a
    /// provider cannot leave to the runtime: admission, the participant count and the
    /// Realtime socket all read perfectly healthy while the room hears nothing. So
    /// unmute, then report `mic_confirmed` honestly, including `false` when the control
    /// could not be read. Never infer it from the absence of evidence: a selector that
    /// has rotted looks exactly like a microphone that is already fine.
    ///
    /// Whether the capture device then actually opens is the runtime's half of the
    /// check — the provider owns the browser, not the audio stack.
    async fn join(&self, page: &PageHandle, options: JoinOptions) -> anyhow::Result<JoinOutcome>;

    /// Is the microphone live? `Some(true)` live, `Some(false)` muted, `None` unreadable.
    ///
    /// A read, and only a read — this must never click anything. The runtime asks on its
    /// participant poll and keeps the answer, so `meeting_status` reports a call nobody can
    /// hear without reading the page mid-turn.
    ///
    /// `None` must not collapse into either answer. "Couldn't read it" is what a rotted
    /// selector produces, and reporting it as live is indistinguishable from a healthy
    /// call right up to the point where nobody can hear the agent.
    ///
    /// Optional: a platform whose microphone state cannot be read offers none of this
    /// (`capabilities().microphone_live`).
    async fn microphone_live(&self, _page: &PageHandle) -> anyhow::Result<Option<bool>> {
        Ok(None)
    }

    /// Turn the microphone on or off, and report the state that was last read.
    ///
    /// Same three values as `microphone_live`, and for the same reason: the caller decides
    /// whether the request was met by comparing the reading with what it asked for, rather
    /// than trusting a boolean that cannot tell "it is off now" from "I could not tell".
    ///
    /// Must not click a control it cannot read. The toggle is a *toggle*, so acting on an
    /// uncertain reading is how a retry mutes a microphone that had just come on; "I don't
    /// know" has to mean "leave it alone and answer `None`". A state that already matches
    /// the request is reported, not clicked.
    ///
    /// Optional, and paired with `microphone_live`: the runtime clicks before it settles for
    /// reading, so a platform offering only the read never reports on a call it could not
    /// make audible (`capabilities().set_microphone`).
    async fn set_microphone(&self, _page: &PageHandle, _on: bool) -> anyhow::Result<Option<bool>> {
        Ok(None)
    }

    /// Post one short plain-text message into the call's own chat.
    ///
    /// Speech stays the only way anything reaches the agent; this is one channel out,
    /// for what does not survive being spoken — a URL, an identifier, a command.
    ///
    /// **Must confirm, not assume.** Resolve `Sent` only on a positive reading
    /// that the page took the message: the composer emptied *and* the text appeared in
    /// the panel. A selector that has rotted looks exactly like a message that went
    /// through, so every path that cannot read the outcome resolves `NotSent` with
    /// the step it stopped at. The caller reports a failure to the model, which then
    /// says so out loud — recoverable. A false success is not.
    ///
    /// The caller normalizes and length-checks the text first, so this receives a
    /// single-line string it can submit as-is.
    ///
    /// Optional: a platform with no chat panel, or none a browser can drive, omits it
    /// (`capabilities().send_chat_message`).
    async fn send_chat_message(
        &self,
        _page: &PageHandle,
        _text: &str,
    ) -> anyhow::Result<ChatSendResult> {
        Ok(ChatSendResult::NotSent {
            step: ChatSendStep::Panel,
            reason: "no chat on this platform".into(),
        })
    }

    /// Read the messages already in the call's own chat, newest last.
    ///
    /// A pull, and only a pull: it is called when somebody in the room asks the agent to
    /// look, so it does one reading and reports what was there. Nothing about it runs on a
    /// timer, and it keeps no record between calls.
    ///
    /// **Must not report an empty chat it is not sure about.** A panel holding messages the
    /// reader cannot parse resolves `NotRead` with step `Read`, since "nobody has typed
    /// anything" and "the selector moved" are the same picture otherwise.
    ///
    /// The panel shares the side rail with the participant list, so this leaves the rail as
    /// it found it: a panel a person had open stays open, and one this call opened is closed
    /// again.
    ///
    /// `limit` caps how many of the newest messages come back and `max_chars_per_message` how
    /// much of each one; both are the caller's, since the bounds exist to keep the result
    /// out of any store.
    ///
    /// Optional: a platform with no chat panel, or none a browser can read, omits it
    /// (`capabilities().read_chat_messages`).
    async fn read_chat_messages(
        &self,
        _page: &PageHandle,
        _options: ChatReadOptions,
    ) -> anyhow::Result<ChatReadResult> {
        Ok(ChatReadResult::NotRead {
            step: ChatReadStep::Panel,
            reason: "no chat on this platform".into(),
        })
    }

    /// Names of the people in the call, best effort, empty when unavailable.
    ///
    /// Optional because it is a hint rather than a mechanism: a platform that cannot
    /// offer it still works, just with a transcriber that has never been told how the
    /// room's names are spelled (`capabilities().participant_names`).
    async fn participant_names(&self, _page: &PageHandle) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }

    /// Put the platform's UI into whatever state lets speech be attributed to a speaker.
    ///
    /// **Never fails**, and must be safe to call repeatedly. The runtime calls it once
    /// immediately after a successful join — before the agent has a voice, so before anything
    /// could be attributed — and then keeps calling it on the participant poll for as long as
    /// no speaker has ever been read. That is the same shape as `set_microphone`, and for the
    /// same reason: one unlucky moment while the control bar is still painting would otherwise
    /// cost attribution for the whole meeting, silently.
    ///
    /// Whether such state survives between calls is the platform's business, and Meet's does
    /// not — its participants panel starts shut, and with it shut the roster is not in the
    /// page at all — so the runtime asks on every join rather than once per profile. A
    /// provider that needs no such preparation may simply not offer this
    /// (`capabilities().enable_speaker_attribution`).
    async fn enable_speaker_attribution(&self, _page: &PageHandle) {}

    /// Who the platform last showed as speaking, or `None` when it cannot be told.
    ///
    /// The audio a meeting bot receives is one mixed channel, so this is the only route to
    /// attribution — and it is a *hint*: it lags real speech, it stops working if the UI
    /// moves, and a platform need not offer it at all. Nothing may become unsafe when it
    /// returns `None`; a caller that cannot work without a speaker has to fall back to
    /// behaving as though the room were anonymous, which is what it did before.
    ///
    /// It is not handed the roster to check a name against. A caption scrape needed that,
    /// because a caption line and a fragment of a sentence are indistinguishable by shape.
    /// Reading the participant list directly removes the ambiguity rather than compensating
    /// for it: a row's own label cannot be a sentence fragment, and the identity attribute
    /// beside it is a second structural check (`capabilities().current_speaker`).
    async fn current_speaker(&self, _page: &PageHandle) -> anyhow::Result<Option<SpeakerReading>> {
        Ok(None)
    }

    /// Start presenting into the call, best effort.
    ///
    /// The room sees the whole display the browser runs on, not one window, because the
    /// capture is a screen. So the thing to show has to be the window on top.
    ///
    /// Reports a failure instead of erroring, as `join` does: a control that moved is
    /// something to say in the room, not a stack trace. Optional, so a platform that
    /// cannot present omits it (`capabilities().start_screen_share`).
    async fn start_screen_share(&self, _page: &PageHandle) -> anyhow::Result<ScreenShareOutcome> {
        Ok(ScreenShareOutcome::Failed {
            reason: "screen sharing is not available on this platform".into(),
        })
    }

    /// Stop presenting, best effort.
    ///
    /// Answers `NotSharing` when there was no presentation to stop. That is a fact about
    /// the room, not an error: the share may have been stopped from the platform's own
    /// controls, or never have started.
    ///
    /// Any provider that offers `start_screen_share` offers this too. A share that
    /// nothing can end lasts for the whole call (`capabilities().stop_screen_share`).
    async fn stop_screen_share(&self, _page: &PageHandle) -> anyhow::Result<ScreenShareOutcome> {
        Ok(ScreenShareOutcome::Failed {
            reason: "screen sharing is not available on this platform".into(),
        })
    }

    /// How many people are in the call, or `None` when it can't be determined.
    ///
    /// Used to leave automatically once the bot is the only one left. `None` is
    /// treated as "don't know, stay" — a UI change should not eject the bot from a
    /// live meeting.
    async fn participant_count(&self, page: &PageHandle) -> anyhow::Result<Option<i64>>;

    /// Leave the call, best effort — the browser is closed right after.
    async fn leave(&self, page: &PageHandle) -> anyhow::Result<()>;
}
