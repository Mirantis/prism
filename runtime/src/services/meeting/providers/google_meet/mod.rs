//! Google Meet, joined as a signed-in participant.
//!
//! Signed in is not a preference, it is the only thing that works. Joining
//! anonymously was tried first and Google auto-denies it: the `CreateMeetingDevice`
//! RPC comes back 403 a second or two after clicking "Ask to join", and the host is
//! never even shown a request. That is policy, not fingerprinting — patched
//! automation (`patchright`), real Chrome, human-like pacing and honest user agents
//! all hit the same wall, while the same browser signed into an account walks in.
//! See `sign_in.rs` for the sign-in itself.
//!
//! Guest support is still here because the anonymous flow is what a *host-less*
//! meeting shows: Meet offers a guest name field for a link whose meeting has ended,
//! even to a signed-in visitor, so the code has to handle it — and `signed_in` tells
//! the two apart in the logs, which is exactly the distinction that cost hours.
//!
//! Everything below is selector-matching against a UI Google reshapes regularly, so
//! each step accepts several phrasings and the whole flow degrades to a clear message
//! instead of a stack trace. Expect to revisit the selectors; that is the standing
//! maintenance cost of every browser-automation meeting bot.

// @generated-modules-start
pub mod participants;
pub mod sign_in;
// @generated-modules-end

use std::sync::LazyLock;

use async_trait::async_trait;

use crate::services::meeting::browser_stack::{Locator, PageHandle, WaitForState};
use crate::services::meeting::meeting_provider_interface::{
    ChatReadOptions, ChatReadResult, ChatSendResult, JoinOptions, JoinOutcome, MeetingProvider,
    ProviderCapabilities, ScreenShareOutcome, SignInOptions, SpeakerReading,
};

/// Wait for a locator to actually be visible, returning false instead of failing.
///
/// `is_visible()` is deliberately NOT used anywhere in this file: it answers
/// "is it visible right now" and returns immediately. Meet renders its join UI in
/// stages, so an immediate check runs before the name field or the join button exist
/// and reports them absent. That mistake is invisible in the logs (the flow just says it
/// found nothing), so the waiting form is factored out here to keep it out of reach.
async fn appears(locator: &Locator, timeout_ms: u64) -> bool {
    locator
        .wait_for(WaitForState::Visible, timeout_ms)
        .await
        .is_ok()
}

/// How long to wait for the initial page furniture before deciding it's broken.
const PAGE_READY_TIMEOUT_MS: u64 = 45_000;

/// Gap between attempts to find the join button (the UI settles in stages).
const JOIN_RETRY_INTERVAL_MS: u64 = 2_000;

/// How long to keep looking for a join button before giving up.
const JOIN_BUTTON_TIMEOUT_MS: u64 = 60_000;

/// Slack in the lobby budget beyond the button hunt itself.
///
/// Was the guest name field's own timeout, back when the flow waited for one. The
/// field is gone with guest joining, but the allowance is not wasted: Meet paints the
/// lobby in stages and the button often appears well after first paint, so the hunt
/// wants headroom beyond its own patience.
const LOBBY_SLACK_MS: u64 = 20_000;

/// Budget for everything before the join request is in — the lobby and the button
/// hunt.
///
/// Deliberately separate from the admission budget. Both used to come out of one
/// deadline computed before the page load, so a slow page load (up to 45 s) plus a slow
/// button hunt (up to 60 s) silently spent the waiting-room budget, and in the tail
/// `wait_for_admission` was entered with its deadline already past — reporting "nobody
/// admitted the request" without having waited even once.
///
/// The trade is a longer worst case: roughly 45 s page load + 80 s lobby + the full
/// admission budget, so about 7 minutes at the 300 s default, against about 6 before.
/// The caller of a join waits for this phase — that is how it learns a join failed
/// before anyone was asked to admit it — so a pathological lobby holds a chat turn for
/// up to two minutes. The admission wait after it is nobody's chat turn, and
/// `MEETING_TIMEOUT_MINUTES` still caps the call.
const LOBBY_PHASE_TIMEOUT_MS: u64 = LOBBY_SLACK_MS + JOIN_BUTTON_TIMEOUT_MS;

/// Reads that must agree before a rejection is believed, and the gap between them.
///
/// One read is whatever Meet happened to have painted in that instant, and acting on
/// it is terminal — so a single match is a hypothesis, not an answer. Meet is an SPA
/// that renders interstitials on the way to the lobby, and a rejection caught
/// mid-render is exactly the intermittent "the meeting has ended" that a retry
/// against the same live link then walked straight past.
const REJECTION_CONFIRM_READS: u32 = 3;
const REJECTION_CONFIRM_INTERVAL_MS: u64 = 1_200;

/// How long to look for a guest name field on a lobby that is not letting us in.
///
/// A Meet lobby paints its controls late, so the field needs waiting for rather than
/// glancing at. Short, because the join is already suspect by the time it runs; a miss
/// falls through to the ordinary join, which Meet then refuses.
const STALE_SESSION_PROBE_MS: u64 = 2_500;

/// Throttle for the "still waiting on the join button" progress line.
const BUTTON_REPORT_INTERVAL_MS: u64 = 10_000;

/// The microphone toggle, matched on the thing about it that doesn't move.
///
/// Not the accessible name: it flips from "Turn on microphone" to "Turn off
/// microphone" the instant the button is pressed, so a locator built from the label
/// we clicked matches nothing when we read the result back — and "matches nothing"
/// is indistinguishable from "still muted".
///
/// `data-is-muted` is both stable and the state itself, so the same locator finds the
/// button and answers the question. The label narrows it to the microphone because the
/// camera toggle carries that attribute too, and neither the tag nor the role is
/// pinned: Meet has rendered these controls as `button` and as `div[role=button]` at
/// different times, and this needs to survive that.
///
/// Public for the tests, which drive the stub through this exact string rather than
/// a copy of it — a copy would keep passing after production changed.
pub const MIC_TOGGLE_SELECTOR: &str = "[data-is-muted][aria-label*=\"microphone\" i]";

/// Modals that render over the call controls.
///
/// Meet drops one on a fresh joiner ("Others may see your video differently"), and its
/// scrim eats pointer events — a click aimed at the mic underneath fails with
/// "subtree intercepts pointer events" and keeps failing until it times out. So the mic
/// is only reachable once this is gone.
pub const BLOCKING_DIALOG_SELECTOR: &str = "[role=\"dialog\"], [role=\"alertdialog\"]";

/// Buttons the dialog sweep is allowed to press — anchored, and never a fallback.
///
/// The tempting shortcut is "press whatever button this dialog offers", and it is the
/// bug this whole change is about: one of the buttons Meet offers is "Continue without
/// microphone", which joins with no capture device at all and cannot be undone by
/// unmuting afterwards. So the sweep only presses things whose entire name is a
/// dismissal, and a dialog it doesn't recognise is left alone and logged. Substring
/// matching would defeat the point — "Continue without microphone" contains none of
/// these, but the next unrecognised affirmative might. JavaScript regular expressions,
/// all with the `i` flag.
const DIALOG_DISMISS_PATTERNS: [&str; 5] =
    ["^got it$", "^dismiss$", "^close$", "^ok$", "^no thanks$"];

/// Dialogs can be stacked, and dismissing one can reveal the next.
const DIALOG_SWEEP_PASSES: u32 = 2;

/// How long to look for a dialog, or for a dismiss button inside one.
///
/// Short because it is paid up to `DIALOG_SWEEP_PASSES` × the pattern list per unmute
/// attempt, and every one of those probes is looking for something that is usually not
/// there. A dialog that needs longer than this to paint has not finished covering the
/// button we are about to click either.
const DIALOG_PROBE_MS: u64 = 500;

/// How long to wait for the mic toggle to paint before calling it absent.
///
/// Paid only once per join, right after admission, and the call UI is already up by
/// then — but Meet paints the control bar in stages and reading too early would report
/// a rotted selector on a perfectly good call.
const MIC_TOGGLE_TIMEOUT_MS: u64 = 10_000;

/// Patience for the reads *after* the toggle has already been found once.
///
/// Short on purpose: the first read establishes the control exists, so spending the
/// full ten seconds on each confirmation only makes a failing unmute take a minute and
/// a half to say so — while the room watches a silent tile.
const MIC_RECHECK_MS: u64 = 1_500;

/// Cap on one unmute click.
const MIC_CLICK_TIMEOUT_MS: u64 = 3_000;

/// Tries at unmuting, and how long to let the toggle settle before believing a read.
///
/// Two, not more, and the reason is that this control is a *toggle*: every attempt is
/// another chance to switch off a microphone that had just come on. One click plus one
/// retry covers the failure actually seen in production — a dialog scrim swallowing the
/// first click — and past that, more attempts trade a known hazard for a shrinking
/// chance of success. A human clicks it once and looks.
const MIC_UNMUTE_ATTEMPTS: u32 = 2;
const MIC_SETTLE_MS: u64 = 750;

/// Wall-clock cap on the whole unmute phase, retries and dialog sweeps included.
///
/// This runs *after* `wait_for_admission` returns, so `admission_timeout_ms` no longer caps
/// anything and something has to. Modest, because failing to unmute no longer ends the
/// call — the agent joins, says it cannot be heard, and listens — so patience here buys
/// very little and is paid in front of a room watching a silent tile.
///
/// Tested between attempts, not inside one, so the true ceiling is this plus a final
/// attempt (~20s worst case, nearly all of it probes timing out on things that are not
/// there).
const MIC_PHASE_TIMEOUT_MS: u64 = 15_000;

/// The chat panel's controls, in one place: the toggle, the composer, the send button.
///
/// All three match what a live call showed once: the toggle is
/// `aria-label="Chat with everyone"` with `aria-expanded` as its only state, the composer
/// is a `textarea[aria-label="Send a message"]`, and the send button carries **the same
/// accessible name as the composer** — which is why this one pins the tag, since a bare
/// `[aria-label="Send a message"]` matches both nodes.
///
/// One reading of one Meet build is not a guarantee, and the panel a non-host sees, or a
/// tenant with chat turned off, was never measured. That is why they are constants and
/// why `send_chat_message` tries several phrasings per step: correcting a selector should
/// be one edit here, not a hunt through a method.
///
/// The design answer to an unverified selector is not more selectors, it is which way a
/// miss falls: every read in `send_chat_message` reports the step it stopped at, and none
/// of them can produce a success. See that method.
///
/// Public for the tests, which drive the stub through these exact strings.
pub const CHAT_TOGGLE_SELECTOR: &str = "button[aria-label*=\"chat\" i]";
pub const CHAT_COMPOSER_SELECTOR: &str = "textarea[aria-label*=\"Send a message\" i]";
pub const CHAT_SEND_SELECTOR: &str = "button[aria-label*=\"Send a message\" i]";

/// One message in the open panel, the text inside it, and the group that holds the name of
/// whoever sent it.
///
/// A message is a node with a `data-message-id` that is not a button. The attribute is
/// Meet's own mark on a message, and a live call showed the row's pin control repeating the
/// id on a button. Rows also have a generated class, which this selector leaves out because
/// a Meet release changes it.
///
/// Meet marks the text of a message with a `jsname` and with nothing else, so that one
/// value is the whole handle on the body. A row whose body node is gone counts as unparsed.
///
/// Meet draws the sender's name and the time once above a run of messages from that person,
/// in a group node with its own `jsname`.
pub const CHAT_MESSAGE_ROW_SELECTOR: &str = "[data-message-id]:not(button)";
pub const CHAT_MESSAGE_BODY_SELECTOR: &str = "[jsname=\"dTKtvb\"]";
pub const CHAT_MESSAGE_GROUP_SELECTOR: &str = "[jsname=\"Ypafjf\"]";

/// How long to wait for the chat control, and then the composer, to paint.
const CHAT_PANEL_TIMEOUT_MS: u64 = 5_000;

/// How long each later phrasing gets, once the expected one has not appeared.
///
/// Short, because a rotted first selector pays this per candidate, and by then the page has
/// already had the full budget above to paint. Long enough not to be an instant check on a
/// busy page.
const CHAT_FALLBACK_PROBE_MS: u64 = 500;

/// How long to look for a send button, after Enter did not send.
///
/// Short: the panel is open and painted by this point, so a button that is not there now is
/// not about to appear, and the wait is silence in the room.
const CHAT_SEND_PROBE_MS: u64 = 1_000;

/// How many times to look for the message on the page, and how long between looks.
///
/// Counted rather than clocked, like `REJECTION_CONFIRM_READS`: a wall-clock deadline
/// around a loop this cheap spins thousands of times in a test and hundreds against a
/// busy page, all of them asking the same question. Eight reads is about two seconds of
/// patience on a page that answers, for something that either lands in one render or is not
/// going to. A page that does not answer makes each read wait out its own timeout instead,
/// which is why the whole send has a deadline over it in the service.
const CHAT_CONFIRM_READS: u32 = 8;
const CHAT_CONFIRM_INTERVAL_MS: u64 = 250;

/// How many reads may go into the baseline count, and how long between them.
///
/// Two agreeing reads end it, so a still panel pays one extra read and a panel painting its
/// history waits it out. Bounded at three reads because the wait is in front of the typing,
/// and everything before the message goes out is silence in the room.
const BASELINE_SETTLE_READS: u32 = 3;
const BASELINE_SETTLE_INTERVAL_MS: u64 = 200;

/// How much of the message has to appear on the page for it to count as sent.
///
/// A prefix rather than the whole string: Meet may wrap, collapse or decorate a long
/// message, and a containment test on all 500 characters would fail on a message that
/// did go through. Enough to be unmistakable, short enough to survive rendering.
const CONFIRM_NEEDLE_CHARS: usize = 60;

/// Cap on one click or one read inside the chat flow.
const CHAT_CLICK_TIMEOUT_MS: u64 = 3_000;
const CHAT_READ_TIMEOUT_MS: u64 = 2_000;

/// Labels Meet has given the control that starts a presentation, newest first.
///
/// Anchored to the start of the name so "Share screen" does not also match the chat
/// panel's "Share a file with everyone". JavaScript regular expressions with the `i` flag.
const SHARE_CONTROL_PATTERNS: [&str; 2] = ["^share screen", "^present now"];

/// The source Meet offers when it asks what to present.
///
/// Only the whole-screen choice is taken. A tab or a window would need a window to
/// exist first, and the display holds exactly one — the browser's own.
const SHARE_SOURCE_PATTERN: &str = "^(your )?entire screen$";

/// Meet's warning about presenting a display that contains the Meet window itself,
/// which is always true here: one virtual display, one browser on it.
///
/// Left unanswered the warning covers the presentation, so this is part of starting
/// one rather than a nicety.
const SELF_VIEW_CONFIRM_PATTERN: &str = "^(show my screen anyway|share anyway|present anyway)$";

/// The control Meet only renders while a presentation is up — the proof it started.
const STOP_SHARING_PATTERN: &str = "^stop (sharing|presenting)";

/// How long to look for a share control, a source menu or the self-view warning.
const SHARE_PROBE_MS: u64 = 2_000;

/// Cap on one click in the share flow.
const SHARE_CLICK_TIMEOUT_MS: u64 = 3_000;

/// How long to wait for the room to actually be seeing the screen.
///
/// The capture needs no picker — a launch flag answers `getDisplayMedia` with the
/// virtual display — but Meet still renegotiates the call before it renders the
/// presenting state, and the self-view warning lands somewhere in the middle of that.
const SHARE_CONFIRM_TIMEOUT_MS: u64 = 15_000;

/// Gap between "is it presenting yet?" reads while the share is being set up.
const SHARE_CONFIRM_INTERVAL_MS: u64 = 1_000;

/// What happened to the microphone on the way in.
///
/// `confirmed` is the only important field: it says whether the room can hear us,
/// and it is deliberately *not* a veto — see `confirm_admitted`. `muted_on_entry` measures
/// how often the platform auto-mutes a joiner, and stays `false` when the toggle could
/// not be read at all, since a reading nobody took must not be filed as an auto-mute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MicOutcome {
    confirmed: bool,
    muted_on_entry: bool,
}

/// Names are handed to the transcriber as decoding hints, so an implausible one is
/// worse than a missing one: it biases the recognizer toward a word nobody says.
///
/// Any script, not just Latin: the reason this reads names at all is that a live
/// call rendered a participant's name in Japanese characters, and rejecting those
/// would drop exactly the hint most needed. The letter test only excludes strings
/// that are punctuation or digits — a stray badge rather than a person.
fn plausible_name(name: &str) -> bool {
    static LETTER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\p{L}").expect("valid regex"));
    let length = crate::support::js::len16(name);
    (2..=40).contains(&length) && LETTER.is_match(name)
}

/// The name the panel shows for whoever sent a message, or `None` when it shows none.
///
/// Meet writes the name and the time in nodes of their own above a run of messages, so the
/// label arrives as those nodes' text one per line and the name is the first of them. Taken
/// that way rather than by cutting a glued string, since what Meet writes around the time
/// moves with the locale and with an edit badge, and each of those read out as part of a
/// name would name somebody who is not in the room.
///
/// Two answers are `None`. A group holding no time is not one Meet draws a name in, and a
/// group whose first line is the time is the agent's own messages, which carry no name.
fn chat_sender_name(label: &str) -> Option<String> {
    static CHAT_GROUP_TIME: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[0-9]{1,2}[:.][0-9]{2}").expect("valid regex"));
    let lines: Vec<&str> = label.split('\n').filter(|line| !line.is_empty()).collect();
    if !lines.iter().any(|line| CHAT_GROUP_TIME.is_match(line)) {
        return None;
    }
    let name = lines[0];
    if CHAT_GROUP_TIME.is_match(name) {
        return None;
    }
    if plausible_name(name) {
        Some(name.to_string())
    } else {
        None
    }
}

/// Cap on one participant-count read.
///
/// A page evaluation has no timeout of its own, and this runs on a timer for the
/// whole call: a read that never settles would stall every later poll behind it,
/// freezing both the response mode and the empty-room check.
const COUNT_READ_TIMEOUT_MS: u64 = 2_000;

/// Cap on the one read that harvests the chat panel.
///
/// Same reason as the count above — a page evaluation has no timeout of its own — and the
/// same number, since it is the same kind of read: one pass over nodes already painted.
/// The service holds a deadline over the whole read as well, because the clicks around
/// this one have their own waits.
const CHAT_LIST_READ_TIMEOUT_MS: u64 = 2_000;

/// Accessible-name patterns for the button that submits a join request.
///
/// Matched as substrings, not exact strings: Meet appends device state to the
/// accessible name, so the guest button is really "Ask to join without camera".
/// An anchored match silently finds nothing. JavaScript regular expressions with the
/// `i` flag.
const JOIN_BUTTON_PATTERNS: [&str; 4] = ["ask to join", "join now", "join anyway", "switch here"];

/// Meet's catch-all wall, which covers several unrelated causes — including the one
/// the runtime can often explain itself. See `explain_denial`.
const CATCH_ALL_REJECTION: &str = "Google Meet wouldn't let me in. Either the meeting has ended, the link is no longer valid, or this meeting only admits signed-in members of its organization.";

/// What the join-button hunt concluded.
///
/// Carries the rejection rather than dropping it — see `click_join_button`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ClickOutcome {
    Clicked,
    NotClicked { rejection: Option<String> },
}

/// Signs the meeting rejected us outright, mapped to what to tell the user. Each pattern
/// is a regular expression matched case-insensitively against the page's visible text.
static REJECTION_PATTERNS: LazyLock<Vec<(regex::Regex, &'static str)>> = LazyLock::new(|| {
    [
        // Meet's catch-all wall. It covers an ended meeting, a link that was never
        // valid, and a tenant that blocks anonymous guests — and the page says the same
        // thing for all three, so the message lists them instead of asserting one.
        (
            r"(?i)you can'?t join this (video call|meeting)",
            CATCH_ALL_REJECTION,
        ),
        (
            r"(?i)no one responded to your request",
            "Nobody admitted the request to join.",
        ),
        (
            r"(?i)your request to join was denied",
            "A host denied the request to join.",
        ),
        (
            r"(?i)this meeting hasn'?t started",
            "The meeting hasn't started yet.",
        ),
        // Anchored to Meet's real copy. The old form made `has` optional, so the bare
        // substring "meeting ended" matched — and this text is scanned against the whole
        // visible page, including chat and captions once the bot is in the room.
        (
            r"(?i)(this|the) (video call|meeting) has ended",
            "The meeting has already ended.",
        ),
        (
            r"(?i)check your meeting code",
            "Google Meet did not recognize that meeting link.",
        ),
        (
            r"(?i)invalid video call name",
            "Google Meet did not recognize that meeting link.",
        ),
    ]
    .into_iter()
    .map(|(pattern, reason)| (regex::Regex::new(pattern).expect("valid regex"), reason))
    .collect()
});

#[derive(Debug, Default)]
pub struct GoogleMeetProvider;

impl GoogleMeetProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl MeetingProvider for GoogleMeetProvider {
    fn name(&self) -> &'static str {
        "google-meet"
    }

    fn display_name(&self) -> &'static str {
        "Google Meet"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            sign_in: true,
            microphone_live: true,
            set_microphone: true,
            send_chat_message: true,
            read_chat_messages: true,
            participant_names: true,
            enable_speaker_attribution: true,
            current_speaker: true,
            start_screen_share: true,
            stop_screen_share: true,
        }
    }

    /// Meet denies an automated anonymous guest before a host is ever prompted — the
    /// `CreateMeetingDevice` RPC answers 403 a second after "Ask to join". Real Chrome,
    /// patched automation, human-like pacing and honest user agents all hit the same
    /// wall; a signed-in account walks in. So an account is not a preference, and a
    /// runtime without one cannot join at all.
    fn configuration_error(&self) -> Option<String> {
        if sign_in::is_authenticated() {
            return None;
        }
        Some(format!(
            "I can't join {} without a Google account: it refuses automated guests before a host is ever asked. Set GOOGLE_BOT_EMAIL and GOOGLE_BOT_PASSWORD and I'll be able to join.",
            self.display_name()
        ))
    }

    /// Never fails — see `sign_in.rs`. A failed login is not a reason to refuse a
    /// join, because the profile's cookies decide whether the browser is signed in,
    /// not this call's opinion of them.
    async fn sign_in(&self, page: &PageHandle, options: SignInOptions) {
        sign_in::sign_in_to_google(page, options).await;
    }

    fn matches_url(&self, url: &str) -> bool {
        match url::Url::parse(url) {
            Ok(parsed) => {
                parsed.scheme() == "https" && parsed.host_str() == Some("meet.google.com")
            }
            Err(_) => false,
        }
    }

    /// Meet reshapes this UI regularly, and a failed join is otherwise only a line
    /// of log text describing selectors that didn't match. A picture of what the
    /// browser was actually looking at turns "the page may have changed" into
    /// something diagnosable without reproducing the call, so every outcome but
    /// `Admitted` saves one.
    async fn join(&self, page: &PageHandle, options: JoinOptions) -> anyhow::Result<JoinOutcome> {
        todo!()
    }

    /// Read the microphone without touching it. `None` when the control cannot be read.
    ///
    /// The short patience rather than `MIC_TOGGLE_TIMEOUT_MS`: this reads a call that is
    /// already up, so a control that is not there now is not about to paint, and a
    /// ten-second wait would hold a poll open for a reading it will take again anyway.
    async fn microphone_live(&self, page: &PageHandle) -> anyhow::Result<Option<bool>> {
        todo!()
    }

    /// Put the microphone in the requested state, mid-call, and report what it reads.
    ///
    /// Thinner than `ensure_mic_on`: one reading, and a click only if that reading disagrees
    /// with the request. A `None` — the control not found — returns `None` without touching
    /// anything, because this runs against a live call and a selector that has rotted would
    /// otherwise become a clicker loose on Meet's control bar. The one-shot patience is
    /// short for the same reason.
    ///
    /// Only a confirmed read is reported. An unreadable one must not come back as the
    /// requested state — that is the reading a rotted selector gives, and it would silence
    /// the retry and the warning together.
    async fn set_microphone(&self, page: &PageHandle, on: bool) -> anyhow::Result<Option<bool>> {
        todo!()
    }

    /// Post one message into the call's chat, and confirm the page took it.
    ///
    /// Meet publishes no chat API, so this is selector-matching against the in-call
    /// panel — see `CHAT_TOGGLE_SELECTOR` and friends for how much of it one live call
    /// measured, and what it did not.
    ///
    /// Which makes the failure direction the whole design. A `Sent` here needs
    /// three independent positives: the composer painted, the draft left it, and the text
    /// turned up on the page *more times than before this send*. Every other path names
    /// the step it stopped at and reports `NotSent`, so a rotted selector produces a
    /// failure the agent then says out loud — recoverable — rather than a room that got
    /// nothing while the agent believes otherwise. Nothing in this method turns a caught
    /// error into a success.
    ///
    /// Every exit closes the panel again, best effort — see `close_chat_panel` for why a
    /// failed send has to do that as carefully as a successful one.
    async fn send_chat_message(
        &self,
        page: &PageHandle,
        text: &str,
    ) -> anyhow::Result<ChatSendResult> {
        todo!()
    }

    /// Read the messages already in the panel, oldest first.
    ///
    /// Each row's body and its group's sender come off the page in one read, bounded by
    /// `CHAT_LIST_READ_TIMEOUT_MS`. The reader counts how many nodes carry a message id at
    /// all: a page with ids but nothing parsed is a selector that has rotted. Nothing parsed
    /// and no ids either asks the toggle again, because a panel that is no longer open lost
    /// the rail to the participants poll. Both report `NotRead` — an empty chat and a chat
    /// the reader cannot see are the same picture, and only one of them is safe to say out
    /// loud.
    ///
    /// The panel is left as it was found: a person who had chat open keeps it, and a panel
    /// this read opened is closed again, because People shares that rail and the empty-room
    /// check reads participant tiles through it.
    async fn read_chat_messages(
        &self,
        page: &PageHandle,
        options: ChatReadOptions,
    ) -> anyhow::Result<ChatReadResult> {
        todo!()
    }

    /// Who is in the call, by name, for the transcriber's keyword list.
    ///
    /// Why names are worth reading at all is observed rather than theoretical: one call rendered
    /// "Miska" as "Mees", "Max" as "Mark", and a third participant's name in Japanese
    /// characters. Names are the words a meeting transcript is worst at and the ones this
    /// feature most depends on — the gate's clearest refusals are of the form "the speaker
    /// addresses Isaac", which only holds when Isaac survives transcription.
    ///
    /// Empty on any failure, including a panel that is not open. A missing hint costs accuracy
    /// and nothing else: the transcriber keeps the agent's own name, and the addressed gate
    /// judges the audio with no roster to check it against.
    async fn participant_names(&self, page: &PageHandle) -> anyhow::Result<Vec<String>> {
        let reading = participants::read_room(page).await;
        Ok(participants::names_from(reading.as_ref())
            .into_iter()
            .filter(|name| plausible_name(name))
            .collect())
    }

    async fn enable_speaker_attribution(&self, page: &PageHandle) {
        participants::open_participants(page).await;
    }

    async fn current_speaker(&self, page: &PageHandle) -> anyhow::Result<Option<SpeakerReading>> {
        let reading = participants::read_room(page).await;
        Ok(reading.as_ref().and_then(participants::judge_speaker))
    }

    /// Present the virtual display into the call.
    ///
    /// Meet asks for up to three clicks: the share control, a menu that asks which source,
    /// and a warning about presenting a screen that holds the meeting window. It does not
    /// always ask for all three. So this clicks each control that is there, and needs none
    /// of them.
    ///
    /// The result comes from the "Stop sharing" control. Meet shows that control only while
    /// a presentation runs, so it is the one reading that is not cosmetic. The failures say
    /// `I could not find Meet's screen-sharing control.` and
    /// `I asked Meet to share the screen and it never started presenting.`
    ///
    /// Chromium answers the capture picker itself — a launch flag selects the virtual
    /// display (see `browser_stack.rs`).
    async fn start_screen_share(&self, page: &PageHandle) -> anyhow::Result<ScreenShareOutcome> {
        todo!()
    }

    /// Stop presenting.
    ///
    /// The control that shows a share is running is also the control that ends it. So no
    /// control means there is nothing to stop, and the result comes from that control
    /// disappearing rather than from the click.
    async fn stop_screen_share(&self, page: &PageHandle) -> anyhow::Result<ScreenShareOutcome> {
        todo!()
    }

    /// How many people are in the call, or `None` when it can't be determined.
    ///
    /// What is left, in order of how much it can be trusted:
    ///
    /// 1. **Panel rows.** Exact and language-independent, but only while the panel is open.
    /// 2. **The People control's count badge.** Meet's own number, and readable with the panel
    ///    shut, which is what keeps the empty-room check working when the panel will not open.
    ///    English, and so the one reading a differently-localised profile loses.
    /// 3. **Distinct participant ids anywhere in the page.** Language-independent, and the last
    ///    thing standing if the panel is shut *and* the control is relabelled. It under-reports
    ///    when Meet virtualizes off-screen tiles, which is why the largest wins.
    ///
    /// One page evaluation rather than a locator per strategy, bounded by
    /// `COUNT_READ_TIMEOUT_MS`: this runs on a timer for the whole call. A closed page, a
    /// navigation mid-read, or a page too busy to answer reads as `None`.
    async fn participant_count(&self, page: &PageHandle) -> anyhow::Result<Option<i64>> {
        todo!()
    }

    /// Click "Leave call" or "Leave meeting" when one appears within two seconds, and log
    /// `[Meeting] Left the call`. Not finding either is not a failure: the browser is closed
    /// immediately after, which drops the WebRTC session and removes the bot from the room
    /// anyway (`[Meeting] No leave button found — closing the browser instead`).
    async fn leave(&self, page: &PageHandle) -> anyhow::Result<()> {
        todo!()
    }
}

pub static GOOGLE_MEET_PROVIDER: LazyLock<GoogleMeetProvider> =
    LazyLock::new(GoogleMeetProvider::new);
