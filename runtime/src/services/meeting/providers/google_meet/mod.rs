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
use serde::Deserialize;
use serde_json::json;

use crate::services::meeting::browser_stack::{
    GotoOptions, LoadState, Locator, PageHandle, ScreenshotOptions, TextMatch, WaitForState,
};
use crate::services::meeting::meeting_provider_interface::{
    ChatMessageRead, ChatReadOptions, ChatReadResult, ChatReadStep, ChatSendResult, ChatSendStep,
    JoinOptions, JoinOutcome, JoinStep, MeetingProvider, ProviderCapabilities, ScreenShareOutcome,
    SignInOptions, SpeakerReading,
};
use crate::support::now_ms;
use crate::utils::with_timeout::with_timeout;
use crate::{log_debug, log_error, log_info, log_warn};

/// A JavaScript regular expression with the `i` flag, as the patterns below are written.
fn pattern(source: &str) -> TextMatch {
    TextMatch::pattern(source, "i")
}

/// How a pattern reads in a log line, as JavaScript prints a regular expression.
fn shown(source: &str) -> String {
    format!("/{source}/i")
}

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

/// The chat controls, each as an ordered list of phrasings.
///
/// Ordered, and probed one at a time by `first_that_appears` — `Locator::or()` cannot
/// express this. An `or` chain matches the union and `.first()` takes the first match **in
/// the document**, so the order written means nothing: whichever candidate's element sits
/// earlier in the DOM wins. That is wrong twice here. The send button carries the same
/// accessible name as the composer, so a union of the two resolves to whichever Meet renders
/// first. And the toggle's broadest phrasing, `aria-label*="chat"`, is a substring match that
/// can pick up another control in the bar — it is last so that it is used last.
fn chat_toggle_candidates(page: &PageHandle) -> Vec<Locator> {
    vec![
        page.get_by_role("button", Some(pattern("chat with everyone")))
            .first(),
        page.get_by_role("button", Some(pattern("^chat$"))).first(),
        page.locator(CHAT_TOGGLE_SELECTOR).first(),
    ]
}

/// The composer. The last phrasing covers a contenteditable rather than a textarea.
fn chat_composer_candidates(page: &PageHandle) -> Vec<Locator> {
    vec![
        page.locator(CHAT_COMPOSER_SELECTOR).first(),
        page.locator("textarea[placeholder*=\"Send a message\" i]")
            .first(),
        page.locator("[role=\"textbox\"][aria-label*=\"message\" i]")
            .first(),
    ]
}

/// The send button, tag pinned first so it is not confused with the composer.
fn chat_send_candidates(page: &PageHandle) -> Vec<Locator> {
    vec![
        page.locator(CHAT_SEND_SELECTOR).first(),
        page.get_by_role("button", Some(pattern("^send"))).first(),
    ]
}

/// The first candidate to appear, probed in the order written.
///
/// The first gets the full budget, since it is the one a live call measured; the rest get one
/// short probe each, so a rotted first selector costs the fallbacks rather than a multiple of
/// the whole timeout.
async fn first_that_appears(candidates: Vec<Locator>, timeout_ms: u64) -> Option<Locator> {
    for (index, candidate) in candidates.into_iter().enumerate() {
        let budget = if index == 0 {
            timeout_ms
        } else {
            CHAT_FALLBACK_PROBE_MS
        };
        if appears(&candidate, budget).await {
            return Some(candidate);
        }
    }
    None
}

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

/// The guest name field.
///
/// Shared by the classification race and the fill so the two cannot disagree. The
/// third alternative is scoped to "your name" rather than any label merely
/// *containing* "name": the looser form matched unrelated text inputs on a signed-in
/// lobby, filled one, and then logged the "meeting has most likely ended" warning at
/// nobody.
fn name_field_locator(page: &PageHandle) -> Locator {
    page.locator("input[aria-label=\"Your name\"]")
        .or(page.locator("input[placeholder=\"Your name\"]"))
        .or(page.locator("input[type=\"text\"][aria-label*=\"your name\" i]"))
        .first()
}

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

/// Where opening the chat panel stopped: no panel, or a panel with no input in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelStep {
    Panel,
    Composer,
}

impl PanelStep {
    fn for_send(self) -> ChatSendStep {
        match self {
            PanelStep::Panel => ChatSendStep::Panel,
            PanelStep::Composer => ChatSendStep::Composer,
        }
    }

    fn for_read(self) -> ChatReadStep {
        match self {
            PanelStep::Panel => ChatReadStep::Panel,
            PanelStep::Composer => ChatReadStep::Composer,
        }
    }
}

/// What one read of the chat panel found.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatHarvest {
    rows: Vec<ChatRow>,
    total: usize,
    id_nodes: usize,
}

#[derive(Debug, Deserialize)]
struct ChatRow {
    label: String,
    text: String,
    cut: bool,
}

/// The chat read run in the page. One pass over the rows already painted, for the same
/// reason the count is one: a locator per message is a round trip per message, and the room
/// is waiting.
const CHAT_HARVEST_PROBE: &str = r#"({ rowSelector, bodySelector, groupSelector, limit, maxChars }) => {
  const doc = globalThis.document;

  // What a group says apart from the messages and the controls in it: the name of
  // the person who sent them, and the time. One line per node, so the reader can
  // tell the name from the time instead of parsing one glued string. Read once
  // per group, since a group holds a run of messages from one person.
  const labels = new Map();
  const labelOf = (row) => {
    const group = row.closest(groupSelector);
    if (!group) return '';
    const known = labels.get(group);
    if (known !== undefined) return known;
    const copy = group.cloneNode(true);
    for (const part of Array.from(copy.querySelectorAll('[data-message-id], button'))) {
      part.remove();
    }
    const label = Array.from(copy.children)
      .map((part) => (part.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join('\n');
    labels.set(group, label);
    return label;
  };

  const rows = [];
  const seen = new Set();
  for (const row of Array.from(doc.querySelectorAll(rowSelector))) {
    const id = row.getAttribute('data-message-id');
    if (!id || seen.has(id)) continue;

    // The body node only, so the name and the time are read from the group rather
    // than glued to the text. A row with no body node counts as unparsed, and an
    // id is taken as read only once a body is found.
    const body = row.querySelector(bodySelector);
    if (!body) continue;
    const text = (body.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    seen.add(id);
    rows.push({
      label: labelOf(row),
      text: text.slice(0, maxChars),
      cut: text.length > maxChars,
    });
  }

  return {
    rows: rows.slice(-limit),
    total: rows.length,
    idNodes: doc.querySelectorAll('[data-message-id]').length,
  };
}"#;

/// The participant count read in the page, three ways. See `participant_count`.
const PARTICIPANT_COUNT_PROBE: &str = r#"() => {
  const doc = globalThis.document;

  const found = [];
  const add = (value) => {
    if (Number.isFinite(value) && value > 0) found.push(value);
  };

  const panel = doc.querySelector('[role="list"][aria-label="Participants"]');
  if (panel) {
    add(
      Array.from(panel.querySelectorAll('[role="listitem"][aria-label]')).filter((row) =>
        row.getAttribute('data-participant-id'),
      ).length,
    );
  }

  // The People control renders its label and a count badge as separate nodes, so
  // the control's combined text reads "People2". Matched on that text rather than a
  // class name, because every class on that subtree is a generated hash that
  // changes without notice — and the control has no aria-label of its own.
  for (const el of Array.from(doc.querySelectorAll('div,span,button'))) {
    const text = el.textContent?.trim() ?? '';
    if (text.length > 24) continue;
    const badge = text.match(/^people\s*(\d{1,4})$/i);
    if (badge) add(parseInt(badge[1], 10));
  }

  // Distinct ids, because the same participant appears both as a tile and as a
  // panel row once the roster is open.
  const ids = new Set(
    Array.from(doc.querySelectorAll('[data-participant-id]')).map((el) =>
      el.getAttribute('data-participant-id'),
    ),
  );
  add(ids.size);

  return found;
}"#;

impl GoogleMeetProvider {
    /// Load the meeting, once more if another navigation lands on top of it.
    ///
    /// A `goto` that a *different* navigation interrupts fails, and one can still be in
    /// flight from the sign-in that ran seconds earlier: Google's redirect chains outlive the
    /// call that started them. The sign-in now parks the page before handing it over, so this
    /// should be rare — but "rare" and "never" are different things when the cost of being
    /// wrong is a user told their meeting link is broken.
    ///
    /// Only that one error is retried. Everything else — a dead link, a timeout, no
    /// network — is a real answer and is reported as it stands.
    async fn load_meeting_page(&self, page: &PageHandle, url: &str) -> anyhow::Result<()> {
        static INTERRUPTED: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)interrupted by another navigation").expect("valid regex")
        });
        let mut attempt = 1;
        loop {
            let loaded = page
                .goto(
                    url,
                    GotoOptions {
                        wait_until: LoadState::DomContentLoaded,
                        timeout_ms: Some(PAGE_READY_TIMEOUT_MS),
                    },
                )
                .await;
            let Err(err) = loaded else {
                return Ok(());
            };
            if attempt > 1 || !INTERRUPTED.is_match(&err.to_string()) {
                return Err(err);
            }
            log_info!("[Meeting] Another navigation landed on the meeting page — loading it again");
            // From a still page, or the interloper's next hop takes the retry down too and
            // reports the same misleading message this exists to prevent.
            sign_in::quiesce(page, None, None).await;
            attempt += 1;
        }
    }

    async fn attempt_join(
        &self,
        page: &PageHandle,
        options: &JoinOptions,
    ) -> anyhow::Result<JoinOutcome> {
        if let Err(err) = self.load_meeting_page(page, &options.url).await {
            return Ok(JoinOutcome::Failed {
                step: JoinStep::PageLoad,
                reason: format!("Could not load the meeting page: {err}"),
            });
        }

        // Everything up to the click shares this; the waiting room gets its own budget
        // below. Capped by the admission timeout as well so a caller asking for a short
        // join gets a short one.
        let lobby_deadline =
            now_ms() + options.admission_timeout_ms.min(LOBBY_PHASE_TIMEOUT_MS) as i64;

        // A rejection can be on screen before we ever reach the name field — but at
        // `domcontentloaded` it can equally be a frame the SPA is about to replace, so
        // this has to be the confirmed reading rather than a single glance.
        if let Some(early) = self.confirmed_rejection(page).await? {
            return Ok(JoinOutcome::Denied {
                step: JoinStep::Lobby,
                reason: self.explain_denial(&early),
            });
        }

        self.dismiss_device_dialogs(page).await;
        // Before the camera toggle and the join click: Meet keeps the join button
        // disabled until the guest name has a value.
        //
        // Three conditions, and all of them have to hold. An account is configured, so a
        // session is meant to exist. Google refused that session when the sign-in call
        // asked. And Meet is offering a guest name field. Going on from there is a
        // guaranteed refusal, because Meet auto-denies automated anonymous guests without
        // ever prompting a host — so say so and let the caller sign in again. A session
        // Google accepted keeps its join even when Meet paints the field, since throwing a
        // live session away is what earns this account a challenge; the probe after the
        // button hunt covers a session that reads live and is refused anyway. The session
        // test comes first so a healthy join pays nothing for the field probe.
        let session = sign_in::session_evidence();
        if sign_in::is_authenticated()
            && !session.as_ref().is_some_and(|s| s.live)
            && self.guest_name_field_present(page, lobby_deadline).await
        {
            log_warn!(
                "[Meeting] Meet is offering a guest name field and the account session is not live ({}) — signing in again before trying the link",
                session
                    .as_ref()
                    .map(|s| s.signal.as_str())
                    .unwrap_or("the session was never checked")
            );
            return Ok(JoinOutcome::ReauthRequired);
        }

        self.turn_off_camera(page).await;

        match self.click_join_button(page, lobby_deadline).await? {
            ClickOutcome::Clicked => {}
            ClickOutcome::NotClicked { rejection } => {
                // Already confirmed inside the loop — reported as-is rather than
                // re-confirmed, because the page may have moved on since.
                if let Some(rejection) = rejection {
                    return Ok(JoinOutcome::Denied {
                        step: JoinStep::Lobby,
                        reason: self.explain_denial(&rejection),
                    });
                }
                // One cause is worth telling apart from selector rot, because it is the one
                // an operator can fix: Meet offering to let us in without a microphone means
                // it found no working capture device, and its panel sits over the join
                // button. That used to be clicked, which got us into calls as a participant
                // who could never say anything; now it stops the join, so the reason had
                // better name the mic rather than blame the page.
                if self.no_microphone_offer(page).await {
                    return Ok(JoinOutcome::Failed {
                        step: JoinStep::Microphone,
                        reason: "Google Meet couldn't find a working microphone in my browser — it only offered to let me in without one, which would have put me in the call unable to say anything, so I didn't join. The container's audio devices are the place to look.".to_string(),
                    });
                }
                // A join button that never enables is the other face of a refused session:
                // Meet keeps it disabled until the guest name has a value, and nothing here
                // fills that field. Asked whatever the session check read, since a session
                // that reads live and is refused anyway lands here — and asked only now, so
                // a healthy join pays nothing for it. The caller signs in again and tries the
                // link once, then reports a second refusal as a denial.
                if sign_in::is_authenticated()
                    && self
                        .guest_name_field_present(page, now_ms() + STALE_SESSION_PROBE_MS as i64)
                        .await
                {
                    log_warn!(
                        "[Meeting] The join button never became available and Meet is asking for a guest name — signing in again before trying the link"
                    );
                    return Ok(JoinOutcome::ReauthRequired);
                }
                // Deliberately not split further by "did we run out of time". The button
                // hunt always runs to the lobby deadline, so an elapsed-budget test is true
                // on every failure path and would make the selector-rot message below
                // unreachable — which is the distinction that actually gets acted on.
                return Ok(JoinOutcome::Failed {
                    step: JoinStep::JoinButton,
                    reason:
                        "The join button never became available — the Meet page may have changed."
                            .to_string(),
                });
            }
        }

        // The request is in: the click landed, and every step that could have failed before
        // it has returned already. What follows is the wait for a host, which is the part
        // the caller must not sit through.
        (options.on_request_submitted)();

        // Measured from the moment the request actually went in, not from the top of the
        // function — see `LOBBY_PHASE_TIMEOUT_MS`.
        self.wait_for_admission(page, now_ms() + options.admission_timeout_ms as i64)
            .await
    }

    /// Add the real cause to Meet's catch-all wall when we already know it.
    ///
    /// Meet says the same thing for an ended meeting, a dead link and a tenant that
    /// blocks guests — and says it *also* when it refused us for being an automated
    /// anonymous guest. In that last case the runtime knows why (sign-in failed
    /// moments earlier) and used to say nothing, so an expired bot password read to
    /// the user as "the meeting has ended".
    fn explain_denial(&self, reason: &str) -> String {
        // Only the catch-all wall is ambiguous enough to be worth annotating; "a host
        // denied the request" is already unambiguous and needs no help.
        let Some(failure) = sign_in::sign_in_failure_reason() else {
            return reason.to_string();
        };
        if reason != CATCH_ALL_REJECTION {
            return reason.to_string();
        }
        format!(
            "{reason} I also couldn't sign in to the Google account configured for me ({failure}), and Google refuses automated anonymous guests — that is the most likely cause."
        )
    }

    /// Grant/dismiss the permission and device-preview dialogs.
    ///
    /// The browser grants its own permission prompt (see `browser_stack.rs`), but Meet
    /// has its own "allow microphone" and "continue without" panels that sit on top of
    /// the join UI.
    async fn dismiss_device_dialogs(&self, page: &PageHandle) {
        // "Got it" dismisses the sign-in tooltip, which floats over the join column
        // and can otherwise intercept a click meant for the controls beneath it.
        //
        // "Continue without microphone" and "Continue without microphone and camera"
        // used to be on this list, and pressing them is how a bot ends up in a call
        // with no capture device — silent for the whole meeting, and past the point
        // where unmuting can help, because there is no device left to unmute. Meet only
        // offers them when it thinks the mic is unavailable; the answer is to let that
        // join fail loudly rather than to accept a mute we cannot recover from.
        for label in ["Got it", "Dismiss"] {
            let button = page.get_by_role("button", Some(pattern(label))).first();
            if appears(&button, 1_500).await && button.click(2_000).await.is_ok() {
                log_info!("[Meeting] Dismissed Meet dialog: {}", label);
            }
            // None of these are required — absence is the normal case.
        }
    }

    /// Is Meet offering to let us in without a microphone?
    ///
    /// Read, never pressed — see `dismiss_device_dialogs`. Meet paints this offer when it
    /// has no capture device to give the tab, and the panel carrying it sits over the
    /// join button, so the visible symptom is a join that never finds its button. That
    /// is a true observation and a useless report: it points at Meet's markup when the
    /// fault is the container's audio devices.
    ///
    /// Text rather than a selector because the wording is what we actually know; the
    /// panel's structure we do not. A miss just falls through to the generic message.
    async fn no_microphone_offer(&self, page: &PageHandle) -> bool {
        static OFFER: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"(?i)continue without (a )?microphone").expect("valid regex")
        });
        match page.locator("body").inner_text(Some(2_000)).await {
            Ok(text) => OFFER.is_match(&text),
            Err(_) => false,
        }
    }

    /// Is Meet asking for a guest name?
    ///
    /// A field that is on screen means Meet treats this browser as a guest, and it
    /// refuses automated anonymous guests. Short-tempered about it, since waiting the
    /// full lobby budget would delay the answer for a join that is already suspect. A
    /// miss is not costly — the join goes ahead and Meet refuses it, which is the outcome
    /// this only makes faster and clearer.
    async fn guest_name_field_present(&self, page: &PageHandle, lobby_deadline: i64) -> bool {
        let budget = (STALE_SESSION_PROBE_MS as i64)
            .min(lobby_deadline - now_ms())
            .max(0);
        if budget == 0 {
            return false;
        }
        name_field_locator(page)
            .wait_for(WaitForState::Visible, budget as u64)
            .await
            .is_ok()
    }

    /// Clear a modal off the call controls, pressing only buttons that just dismiss.
    ///
    /// Returns quietly when there is no dialog, which is the common case. When there is
    /// one it doesn't recognise, it says so and leaves it: the click it would otherwise
    /// guess at is the one that joins without a microphone. See `DIALOG_DISMISS_PATTERNS`.
    ///
    /// The button hunt is page-wide rather than scoped inside the dialog. Scoping reads
    /// better but buys nothing here — the allowlist is anchored to whole names that only
    /// ever mean "dismiss", so pressing one that belongs to something else on the page is
    /// harmless, and the dialog is what we already know is on top.
    async fn dismiss_blocking_dialogs(&self, page: &PageHandle) {
        let dialog = page.locator(BLOCKING_DIALOG_SELECTOR).first();

        for _pass in 1..=DIALOG_SWEEP_PASSES {
            if !appears(&dialog, DIALOG_PROBE_MS).await {
                return;
            }

            for source in DIALOG_DISMISS_PATTERNS {
                let button = page.get_by_role("button", Some(pattern(source))).first();
                if !appears(&button, DIALOG_PROBE_MS).await {
                    continue;
                }
                if button.click(2_000).await.is_ok() {
                    log_info!(
                        "[Meeting] Cleared a dialog off the call controls (matched {})",
                        shown(source)
                    );
                    break;
                }
                // Went stale mid-click, or something else took it — try the next phrasing.
            }
        }

        // Judged on the dialog rather than on "did I click something", because the two
        // can disagree: the hunt is page-wide, so a match can belong to something else
        // entirely and leave the modal exactly where it was.
        if appears(&dialog, DIALOG_PROBE_MS).await {
            log_warn!(
                "[Meeting] A dialog is still covering the call controls — either its buttons are not ones I will press, or clearing it did not work"
            );
        }
    }

    /// Is the microphone muted? `None` means the toggle could not be read at all.
    ///
    /// Three-valued on purpose. "Couldn't read it" must not collapse into "it's fine":
    /// that reading is what a rotted selector produces, and treating it as unmuted is
    /// indistinguishable from success right up to the point where nobody can hear the
    /// agent. Anything other than a literal `"false"` counts as muted for the same
    /// reason — an attribute Meet renames is not permission to assume the best.
    async fn mic_muted(&self, page: &PageHandle, timeout_ms: u64) -> Option<bool> {
        let toggle = page.locator(MIC_TOGGLE_SELECTOR).first();
        if !appears(&toggle, timeout_ms).await {
            return None;
        }
        match toggle.get_attribute("data-is-muted", None).await {
            Ok(Some(muted)) => Some(muted != "false"),
            _ => None,
        }
    }

    /// Get the microphone live, and report whether Meet had muted us.
    ///
    /// Meet auto-mutes a new joiner once a call is past a handful of participants, which
    /// is exactly the meeting anyone bothers to send an agent to. Nothing downstream can
    /// see it — admission, the participant count and the Realtime socket all read healthy
    /// while the agent greets a room that hears nothing — so the unmute is part of getting
    /// in, and what came of it is reported rather than assumed.
    ///
    /// This is the same click a human makes when Meet mutes them on the way in, and it
    /// carries the same consequence: if it does not work, you are in a meeting nobody can
    /// hear you in. What the agent does about that is `confirm_admitted`'s business.
    async fn ensure_mic_on(&self, page: &PageHandle) -> anyhow::Result<MicOutcome> {
        let Some(initial) = self.mic_muted(page, MIC_TOGGLE_TIMEOUT_MS).await else {
            log_error!(
                "[Meeting] Could not read the microphone toggle on the call UI — the Meet controls may have changed, and I cannot tell whether the room can hear me"
            );
            // Not filed as an auto-mute: this is a reading nobody took, and counting it would
            // inflate `muted_on_entry` in exactly the outage that produces it.
            return Ok(MicOutcome {
                confirmed: false,
                muted_on_entry: false,
            });
        };

        if !initial {
            log_info!("[Meeting] Microphone was already live on arrival");
            return Ok(MicOutcome {
                confirmed: true,
                muted_on_entry: false,
            });
        }

        log_info!("[Meeting] Meet put me in the call muted — unmuting");
        let deadline = now_ms() + MIC_PHASE_TIMEOUT_MS as i64;
        let mut attempt = 1;
        while attempt <= MIC_UNMUTE_ATTEMPTS && now_ms() < deadline {
            // Every attempt, not just the first: the dialog that eats the click can arrive
            // after the sweep, and a click that was swallowed leaves no trace beyond the
            // toggle not having moved.
            self.dismiss_blocking_dialogs(page).await;

            if let Err(err) = page
                .locator(MIC_TOGGLE_SELECTOR)
                .first()
                .click(MIC_CLICK_TIMEOUT_MS)
                .await
            {
                // Reported rather than swallowed: "subtree intercepts pointer events" here
                // is the scrim, and it is the difference between a UI change and a covered
                // button.
                log_info!("[Meeting] Unmute attempt {} did not land: {}", attempt, err);
            }

            page.wait_for_timeout(MIC_SETTLE_MS).await?;
            // The short patience: the toggle was found on the read above, so a confirmation
            // that has to wait ten seconds for it is waiting for something else.
            let mut after = self.mic_muted(page, MIC_RECHECK_MS).await;
            // "Couldn't read it" must not fall through to the next attempt as if it said
            // muted: if the click did land, clicking again would mute a microphone that is
            // now live — the original bug, re-entered through the retry. Pay the full
            // patience once before spending an attempt on it.
            if after.is_none() {
                after = self.mic_muted(page, MIC_TOGGLE_TIMEOUT_MS).await;
            }
            if after == Some(false) {
                log_info!("[Meeting] Microphone is live (took {} attempt(s))", attempt);
                return Ok(MicOutcome {
                    confirmed: true,
                    muted_on_entry: true,
                });
            }
            attempt += 1;
        }

        log_error!("[Meeting] Microphone is still muted after every attempt");
        Ok(MicOutcome {
            confirmed: false,
            muted_on_entry: true,
        })
    }

    /// Put the side rail back the way the read found it.
    ///
    /// A panel that read as open before the click belongs to a person in the call, and
    /// closing it would take the chat away from them mid-conversation. Everything else is
    /// closed: a panel this read opened, and a toggle that would not say, since the reading
    /// that costs the call is a rail left on chat while the empty-room check counts tiles.
    async fn restore_chat_panel(&self, toggle: &Locator, was_open: Option<bool>) {
        if was_open == Some(true) {
            return;
        }
        self.close_chat_panel(toggle).await;
    }

    /// Get the panel open, and hand back the composer in it.
    ///
    /// Answers the failure rather than a boolean, so the two reasons stay apart: a panel
    /// that would not open is `panel`, a panel that painted no input is `composer`, and
    /// those are different problems for whoever reads the telemetry.
    ///
    /// The failure carries the step and the reason alone, since a send and a read both open
    /// the panel this way and each puts it into its own result shape.
    async fn open_chat_panel(
        &self,
        page: &PageHandle,
        toggle: &Locator,
    ) -> Result<Locator, (PanelStep, String)> {
        if self.panel_is_open(toggle).await != Some(true) {
            // Same reason the unmute does this: a modal's scrim eats the click, and the
            // click reports success on the scrim rather than on the button underneath.
            self.dismiss_blocking_dialogs(page).await;
            if let Err(err) = toggle.click(CHAT_CLICK_TIMEOUT_MS).await {
                return Err((
                    PanelStep::Panel,
                    format!("the chat control would not open: {err}"),
                ));
            }
        }

        // The first of the three positives a send needs: the composer painted. `appears`
        // waits; `is_visible` would not — see its doc comment.
        match first_that_appears(chat_composer_candidates(page), CHAT_PANEL_TIMEOUT_MS).await {
            Some(composer) => Ok(composer),
            None => Err((
                PanelStep::Composer,
                "the chat panel did not paint an input".to_string(),
            )),
        }
    }

    /// Is the chat panel open? `Some(true)`, `Some(false)`, or `None` when the toggle will
    /// not say.
    ///
    /// `aria-expanded` on the toggle is the one piece of panel state Meet publishes, and it
    /// answers immediately. The alternative is probing for the composer, which asks a
    /// different question: a panel that is open but a render behind reads as closed, and the
    /// probe then either clicks the panel shut or has to be short enough to race.
    async fn panel_is_open(&self, toggle: &Locator) -> Option<bool> {
        match toggle
            .get_attribute("aria-expanded", Some(CHAT_READ_TIMEOUT_MS))
            .await
        {
            Ok(Some(expanded)) => {
                Some(crate::support::js::trim(&expanded).to_lowercase() == "true")
            }
            _ => None,
        }
    }

    /// Close the panel again. Never changes the reported outcome.
    ///
    /// Not cosmetic, and not conditional on the send having worked: the panel shares the side
    /// rail with People, `participant_count` reads participant tiles, and a count of one for a
    /// minute is what makes the runtime leave the call. So every exit from a send comes
    /// through here.
    ///
    /// Reads the state first, because the control is a toggle and something else can have
    /// closed the panel already — the participants poll shares that rail, so a click landing
    /// after it would *open* chat instead. A toggle that will not say gets the click: a panel
    /// left open is the reading that costs the call, and clicking a closed panel open is what
    /// the next poll undoes.
    async fn close_chat_panel(&self, toggle: &Locator) {
        if self.panel_is_open(toggle).await == Some(false) {
            return;
        }
        // Best effort. The next send opens it again, and the count poll tolerates a
        // reading it cannot take — it is a low reading that costs us.
        let _ = toggle.click(CHAT_CLICK_TIMEOUT_MS).await;
    }

    /// Did the page take the message? Two readings, both required.
    ///
    /// Neither alone is worth anything. An empty composer on its own is what Meet shows
    /// for a send the server then dropped. The text being on the page on its own is
    /// *worse*: an unsent draft is still sitting in the composer, inside the panel, so a
    /// containment test would match the exact failure it is meant to catch. Together they
    /// mean the draft went somewhere and the text is in the room's message list — which is
    /// read without a selector for that list, the most volatile node in the panel and the
    /// one there is least evidence about.
    ///
    /// `before` is why this counts rather than contains. A containment test answers "is
    /// this text on the page", which is already true of anything the agent posted earlier
    /// in the call, so a second send of the same link would read as confirmed by the first
    /// one's message. Counting answers "is there one more of it than there was", which
    /// only the send can make true.
    ///
    /// Known false negative, unverified: a long message Meet renders collapsed behind a
    /// "show more" could fail the count having actually been sent. 60 characters of a
    /// message capped at 500 makes that unlikely, and it fails in the safe direction.
    async fn confirm_sent(
        &self,
        page: &PageHandle,
        composer: &Locator,
        needle: &str,
        before: i64,
    ) -> anyhow::Result<bool> {
        for read in 1..=CHAT_CONFIRM_READS {
            // The first look is immediate: a send that landed should not be made to wait an
            // interval before the agent may speak about it.
            if read > 1 {
                page.wait_for_timeout(CHAT_CONFIRM_INTERVAL_MS).await?;
            }

            if !self.read_draft(composer).await.is_empty() {
                continue;
            }
            // A read that failed is not a reading of zero. There are more reads after it,
            // and then a reported failure.
            if let Some(now) = self.count_on_page(page, needle).await {
                if now > before {
                    return Ok(true);
                }
            }
        }

        Ok(false)
    }

    /// The baseline count, once it stops moving. `None` if any read of it fails.
    ///
    /// The panel paints its history when it opens, and the composer can be there a moment
    /// before the messages are. A baseline read in that moment is too low, and a message that
    /// paints later — during the confirmation reads — then counts as this send: a success the
    /// room never got. So the count has to agree with itself twice before anything is typed.
    ///
    /// Costs one extra read on a still panel, since the second read agrees with the first.
    async fn settled_count(&self, page: &PageHandle, needle: &str) -> anyhow::Result<Option<i64>> {
        let mut last: Option<i64> = None;
        for read in 1..=BASELINE_SETTLE_READS {
            if read > 1 {
                page.wait_for_timeout(BASELINE_SETTLE_INTERVAL_MS).await?;
            }
            // Unreadable is fatal here rather than something to retry past: a baseline
            // nobody could take is what makes an unconfirmable send look confirmed.
            let Some(now) = self.count_on_page(page, needle).await else {
                return Ok(None);
            };
            if Some(now) == last {
                return Ok(Some(now));
            }
            last = Some(now);
        }
        // Still moving after that many reads. The newest reading is the best there is, and
        // the other two positives a send needs still have to hold on top of it.
        Ok(last)
    }

    /// How many times `needle` appears in the page's text, or `None` when it cannot be read.
    ///
    /// `None` rather than 0 for an unreadable page: 0 is a number the caller compares, and a
    /// busy page must not be able to make a count look like it went up.
    async fn count_on_page(&self, page: &PageHandle, needle: &str) -> Option<i64> {
        let page_text = page
            .locator("body")
            .inner_text(Some(CHAT_READ_TIMEOUT_MS))
            .await
            .ok()?;
        if needle.is_empty() {
            return Some(crate::support::js::len16(&page_text) as i64 - 1);
        }
        Some(page_text.matches(needle).count() as i64)
    }

    /// What is still in the composer, or `"unknown"` when it cannot be read.
    ///
    /// Reading the value fails on a contenteditable, which is one of the shapes the composer
    /// locator accepts, so the rendered text is the fallback. An unreadable box answers
    /// `"unknown"` rather than `""`: only a box confirmed empty may contribute to a
    /// success, and "I could not look" is not that.
    async fn read_draft(&self, composer: &Locator) -> String {
        if let Ok(value) = composer.input_value(Some(CHAT_READ_TIMEOUT_MS)).await {
            return crate::support::js::trim(&value).to_string();
        }
        match composer.inner_text(Some(CHAT_READ_TIMEOUT_MS)).await {
            Ok(text) => crate::support::js::trim(&text).to_string(),
            Err(_) => "unknown".to_string(),
        }
    }

    /// Report the admission, with what became of the microphone attached.
    ///
    /// Both admission paths go through here so neither can grow an `Admitted` that never
    /// tried the microphone at all — the unmute is part of getting in, not something the
    /// call does later.
    ///
    /// A microphone it could not confirm is **not** a failed join. The agent hears the
    /// room through a different device entirely (`meet_out.monitor`, nothing to do with
    /// the mic), so a muted agent is still a listener with its full tool surface, and
    /// leaving would throw that away. It is also a scraped DOM attribute: taking Google
    /// renaming it as grounds to abandon meetings would turn a cosmetic UI change into a
    /// total outage. So this reports what it knows and lets the runtime tell somebody —
    /// which is the property the veto was really after, without the amputation.
    async fn confirm_admitted(&self, page: &PageHandle) -> anyhow::Result<JoinOutcome> {
        let mic = self.ensure_mic_on(page).await?;

        if !mic.confirmed {
            log_warn!(
                "[Meeting] Joining with a microphone I could not confirm is live — the room may hear nothing from me"
            );
        }

        Ok(JoinOutcome::Admitted {
            muted_on_entry: mic.muted_on_entry,
            mic_confirmed: mic.confirmed,
        })
    }

    /// Leave the camera off.
    ///
    /// There is no camera device in the container, so this is about how the bot
    /// appears to the room (an avatar tile rather than a broken video tile) and about
    /// not having Meet retry a device that will never work.
    async fn turn_off_camera(&self, page: &PageHandle) {
        let camera = page
            .get_by_role("button", Some(pattern("turn off camera")))
            .first();
        if appears(&camera, 2_000).await && camera.click(2_000).await.is_ok() {
            log_info!("[Meeting] Camera turned off");
        }
        // Already off, or no camera control on this page.
    }

    /// Find and press the join button, retrying while the page settles.
    ///
    /// Retrying rather than waiting once: the button's label changes as Meet decides
    /// whether we're a guest ("Ask to join") or a member ("Join now"), and it is
    /// briefly present-but-disabled in between.
    ///
    /// Hands back the rejection it found rather than a bare false. Discarding it meant
    /// the caller had to confirm all over again — several seconds later — and if the
    /// wall text had repainted away by then, a genuine denial was reported as "the join
    /// button never became available", blaming the Meet UI for a refusal we had already
    /// read twice.
    async fn click_join_button(
        &self,
        page: &PageHandle,
        deadline: i64,
    ) -> anyhow::Result<ClickOutcome> {
        let started_at = now_ms();
        // `deadline` already carries the lobby-phase cap, so there is nothing left to
        // min() against here.
        let button_deadline = deadline;
        let mut last_report = 0;

        while now_ms() < button_deadline {
            for source in JOIN_BUTTON_PATTERNS {
                let button = page.get_by_role("button", Some(pattern(source))).first();
                if !appears(&button, 1_000).await {
                    continue;
                }
                // Present but disabled is the normal state until the name field has a
                // value and Meet has finished probing devices, so this is a retry
                // condition rather than a failure.
                match button.is_enabled(30_000).await {
                    Ok(true) => {}
                    Ok(false) => {
                        // Reported at info, throttled: at debug a 60-second hunt left no
                        // trace at all, so the only evidence was the terminal "may have
                        // changed" message.
                        if now_ms() - last_report > BUTTON_REPORT_INTERVAL_MS as i64 {
                            last_report = now_ms();
                            log_info!(
                                "[Meeting] Join button matching {} is not enabled yet ({}ms so far)",
                                shown(source),
                                now_ms() - started_at
                            );
                        }
                        continue;
                    }
                    // Not this pattern, or it went stale mid-check — keep looking.
                    Err(_) => continue,
                }
                if button.click(5_000).await.is_ok() {
                    log_info!(
                        "[Meeting] Clicked the join button (matched {}) after {}ms",
                        shown(source),
                        now_ms() - started_at
                    );
                    return Ok(ClickOutcome::Clicked);
                }
            }

            if let Some(rejection) = self.confirmed_rejection(page).await? {
                return Ok(ClickOutcome::NotClicked {
                    rejection: Some(rejection),
                });
            }
            page.wait_for_timeout(JOIN_RETRY_INTERVAL_MS).await?;
        }

        log_info!(
            "[Meeting] Gave up looking for a join button after {}ms",
            now_ms() - started_at
        );
        Ok(ClickOutcome::NotClicked { rejection: None })
    }

    /// Wait out the waiting room.
    ///
    /// Admission is inferred from in-call furniture appearing (the leave button, the
    /// participants panel) because Meet exposes no explicit "you are in" signal.
    async fn wait_for_admission(
        &self,
        page: &PageHandle,
        deadline: i64,
    ) -> anyhow::Result<JoinOutcome> {
        log_info!("[Meeting] Waiting to be admitted");
        let started_at = now_ms();

        while now_ms() < deadline {
            if self.is_in_call(page).await {
                log_info!(
                    "[Meeting] Admitted to the call after {}ms",
                    now_ms() - started_at
                );
                return self.confirm_admitted(page).await;
            }

            if let Some(rejection) = self.confirmed_rejection(page).await? {
                // Confirming takes a couple of seconds, and admission can land inside that
                // window. Being in the room outranks any text on it.
                if self.is_in_call(page).await {
                    log_info!("[Meeting] Admitted while a rejection message was being confirmed");
                    return self.confirm_admitted(page).await;
                }
                return Ok(JoinOutcome::Denied {
                    step: JoinStep::Admission,
                    reason: self.explain_denial(&rejection),
                });
            }

            page.wait_for_timeout(1_500).await?;
        }

        Ok(JoinOutcome::Denied {
            step: JoinStep::Admission,
            reason: "Nobody admitted the request to join before the wait timed out.".to_string(),
        })
    }

    /// In-call furniture — the closest thing Meet gives us to an "admitted" flag.
    ///
    /// Two more markers used to be listed here, `button[aria-label*="People"]` and
    /// `[data-participant-count]`. A live probe of every `aria-label` on the page found
    /// neither, which is the same finding that removed them from `participant_count` — and
    /// here they were not merely inert: each one costs its own 400ms wait on the *not*
    /// in-call path, which is the path every admission poll and every rejection check takes.
    async fn is_in_call(&self, page: &PageHandle) -> bool {
        for selector in [
            "button[aria-label*=\"Leave call\" i]",
            "button[aria-label*=\"Leave meeting\" i]",
        ] {
            if appears(&page.locator(selector).first(), 400).await {
                return true;
            }
        }
        false
    }

    /// Save what the page looked like when a join failed, best effort.
    ///
    /// Written into the persistent data dir under a fixed name — one artifact from
    /// the most recent failure, not a growing pile — and never allowed to affect the
    /// outcome being reported.
    async fn capture_failure(&self, page: &PageHandle) {
        let path = format!(
            "{}/meeting-join-failure.png",
            crate::lib::data_dir::resolve_data_dir()
        );
        let shot = page
            .screenshot(ScreenshotOptions {
                path: Some(path.clone().into()),
                timeout_ms: Some(5_000),
                ..ScreenshotOptions::default()
            })
            .await;
        match shot {
            Ok(_) => log_info!(
                "[Meeting] Saved a screenshot of the failed join to {}",
                path
            ),
            Err(err) => log_debug!(
                "[Meeting] Could not capture the failure screenshot: Error: {}",
                err
            ),
        }
    }

    /// A rejection that held still — the only kind worth acting on.
    ///
    /// Costs nothing in the common case: a page with no rejection text takes one read
    /// and returns. Only once something matches do we pay for confirmation, and that is
    /// exactly when it is worth paying, because the alternative is ending the join on a
    /// frame Meet was about to replace.
    async fn confirmed_rejection(&self, page: &PageHandle) -> anyhow::Result<Option<String>> {
        let Some(first) = self.read_rejection(page).await else {
            return Ok(None);
        };

        for _ in 1..REJECTION_CONFIRM_READS {
            // If we are already in the room, whatever the page says is stale by
            // definition — chat and captions are part of the text being scanned.
            if self.is_in_call(page).await {
                log_info!("[Meeting] Ignoring rejection text — already in the call");
                return Ok(None);
            }
            page.wait_for_timeout(REJECTION_CONFIRM_INTERVAL_MS).await?;
            // Compared on the mapped reason, so a *different* rejection on a later read
            // also counts as a page that has not settled.
            if self.read_rejection(page).await.as_deref() != Some(first.as_str()) {
                log_info!(
                    "[Meeting] A rejection message did not persist — continuing (was: {})",
                    crate::support::js::slice16(&first, 0, 60)
                );
                return Ok(None);
            }
        }
        Ok(Some(first))
    }

    /// Scan the visible text for a known rejection, returning what to tell the user.
    async fn read_rejection(&self, page: &PageHandle) -> Option<String> {
        let text = page.locator("body").inner_text(Some(2_000)).await.ok()?;
        REJECTION_PATTERNS
            .iter()
            .find(|(pattern, _)| pattern.is_match(&text))
            .map(|(_, reason)| reason.to_string())
    }

    /// The first control matching any of these names, or `None`.
    ///
    /// Buttons and menu items are searched together because Meet renders these choices as
    /// one or the other, and every caller here wants whichever it turns out to be. The
    /// patterns are anchored by their authors for the reason `DIALOG_DISMISS_PATTERNS` is:
    /// this clicks things on a live call, and a loose match on a control bar full of verbs
    /// is how a share tool stops a share.
    async fn find_control(&self, page: &PageHandle, patterns: &[&str]) -> Option<Locator> {
        for source in patterns {
            let control = page
                .get_by_role("button", Some(pattern(source)))
                .or(page.get_by_role("menuitem", Some(pattern(source))))
                .first();
            if appears(&control, SHARE_PROBE_MS).await {
                return Some(control);
            }
        }
        None
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
        let outcome = self.attempt_join(page, &options).await?;
        if !matches!(outcome, JoinOutcome::Admitted { .. }) {
            self.capture_failure(page).await;
        }
        Ok(outcome)
    }

    /// Read the microphone without touching it. `None` when the control cannot be read.
    ///
    /// The short patience rather than `MIC_TOGGLE_TIMEOUT_MS`: this reads a call that is
    /// already up, so a control that is not there now is not about to paint, and a
    /// ten-second wait would hold a poll open for a reading it will take again anyway.
    async fn microphone_live(&self, page: &PageHandle) -> anyhow::Result<Option<bool>> {
        Ok(self
            .mic_muted(page, MIC_RECHECK_MS)
            .await
            .map(|muted| !muted))
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
        let Some(muted) = self.mic_muted(page, MIC_RECHECK_MS).await else {
            return Ok(None);
        };
        let live = !muted;
        if live == on {
            return Ok(Some(live));
        }

        self.dismiss_blocking_dialogs(page).await;
        if page
            .locator(MIC_TOGGLE_SELECTOR)
            .first()
            .click(MIC_CLICK_TIMEOUT_MS)
            .await
            .is_err()
        {
            // Still covered, or gone. Report the state read before the click, which
            // disagrees with the request, so the caller reads a failure. Safe even if the
            // click did land: the next call reads the new state and returns without
            // clicking again.
            return Ok(Some(live));
        }

        page.wait_for_timeout(MIC_SETTLE_MS).await?;
        self.microphone_live(page).await
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
        let not_sent = |step: ChatSendStep, reason: &str| ChatSendResult::NotSent {
            step,
            reason: reason.to_string(),
        };

        let Some(toggle) =
            first_that_appears(chat_toggle_candidates(page), CHAT_PANEL_TIMEOUT_MS).await
        else {
            return Ok(not_sent(
                ChatSendStep::Panel,
                "no chat control on the call page",
            ));
        };

        let composer = match self.open_chat_panel(page, &toggle).await {
            Ok(composer) => composer,
            Err((step, reason)) => {
                // Closed on this path too: opening reports `composer` after clicking the
                // panel open, so this is the failure that leaves a panel over the
                // participant tiles.
                self.close_chat_panel(&toggle).await;
                return Ok(not_sent(step.for_send(), &reason));
            }
        };

        // Read before anything is typed. The confirmation is that this number went up, so
        // the baseline has to predate both the draft and the message: the same link posted
        // twice in one call would otherwise confirm the second send off the first one's
        // message, still sitting in the panel above it.
        let needle = crate::support::js::slice16(text, 0, CONFIRM_NEEDLE_CHARS);
        let Some(before) = self.settled_count(page, &needle).await? else {
            self.close_chat_panel(&toggle).await;
            return Ok(not_sent(
                ChatSendStep::Confirm,
                "the page could not be read before sending, so no send could be confirmed",
            ));
        };

        if let Err(err) = composer.fill(text, CHAT_CLICK_TIMEOUT_MS).await {
            self.close_chat_panel(&toggle).await;
            return Ok(not_sent(
                ChatSendStep::Composer,
                &format!("could not type into the chat box: {err}"),
            ));
        }

        // Enter is how Meet sends, and `fill` above put the text in as one operation, so
        // there is no keystroke to trip it early. The caller has already collapsed every
        // run of whitespace, so no newline can submit a fragment or split the message.
        // A failure falls through: the send button below is the other way in.
        let _ = composer.press("Enter", CHAT_CLICK_TIMEOUT_MS).await;

        if self.confirm_sent(page, &composer, &needle, before).await? {
            self.close_chat_panel(&toggle).await;
            return Ok(ChatSendResult::Sent);
        }

        // One fallback, not a retry loop: a panel whose Enter handler moved still has a
        // send button, and pressing it is a different path rather than the same one again.
        let Some(send) = first_that_appears(chat_send_candidates(page), CHAT_SEND_PROBE_MS).await
        else {
            self.close_chat_panel(&toggle).await;
            return Ok(not_sent(
                ChatSendStep::Send,
                "Enter did not send and there is no send button",
            ));
        };

        if let Err(err) = send.click(CHAT_CLICK_TIMEOUT_MS).await {
            self.close_chat_panel(&toggle).await;
            return Ok(not_sent(
                ChatSendStep::Send,
                &format!("the send button would not take a click: {err}"),
            ));
        }

        let confirmed = self.confirm_sent(page, &composer, &needle, before).await?;
        self.close_chat_panel(&toggle).await;
        Ok(if confirmed {
            ChatSendResult::Sent
        } else {
            not_sent(
                ChatSendStep::Confirm,
                "the page never showed the message as sent",
            )
        })
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
        let not_read = |step: ChatReadStep, reason: &str| ChatReadResult::NotRead {
            step,
            reason: reason.to_string(),
        };

        let Some(toggle) =
            first_that_appears(chat_toggle_candidates(page), CHAT_PANEL_TIMEOUT_MS).await
        else {
            return Ok(not_read(
                ChatReadStep::Panel,
                "no chat control on the call page",
            ));
        };

        // Read before the click, so the restore can tell a panel somebody else opened from
        // one this read opened. A toggle that will not say is treated as ours to close.
        let was_open = self.panel_is_open(&toggle).await;

        if let Err((step, reason)) = self.open_chat_panel(page, &toggle).await {
            self.restore_chat_panel(&toggle, was_open).await;
            return Ok(not_read(step.for_read(), &reason));
        }

        let harvest = with_timeout(
            page.evaluate_function(
                CHAT_HARVEST_PROBE,
                json!({
                    "rowSelector": CHAT_MESSAGE_ROW_SELECTOR,
                    "bodySelector": CHAT_MESSAGE_BODY_SELECTOR,
                    "groupSelector": CHAT_MESSAGE_GROUP_SELECTOR,
                    "limit": options.limit,
                    "maxChars": options.max_chars_per_message,
                }),
            ),
            CHAT_LIST_READ_TIMEOUT_MS as i64,
        )
        .await
        .and_then(|value| Ok(serde_json::from_value::<ChatHarvest>(value)?));

        let result = match harvest {
            // A closed page, a navigation mid-read, or a page too busy to answer.
            Err(_) => not_read(ChatReadStep::Read, "the page did not answer the chat read"),
            Ok(harvest) => {
                // Nothing parsed has three possible reasons: the chat is empty, the selectors
                // no longer match, or the panel closed. Ids on the page mean the page has
                // messages this code could not read. An empty chat is reported only when
                // neither of the other two is true, and a toggle that does not answer counts
                // as still open.
                if harvest.total == 0 && harvest.id_nodes > 0 {
                    not_read(
                        ChatReadStep::Read,
                        "the panel had messages the reader could not parse",
                    )
                } else if harvest.total == 0 && self.panel_is_open(&toggle).await == Some(false) {
                    not_read(ChatReadStep::Read, "the chat panel closed during the read")
                } else {
                    let truncated = harvest.total > harvest.rows.len();
                    ChatReadResult::Read {
                        messages: harvest
                            .rows
                            .into_iter()
                            .map(|row| ChatMessageRead {
                                sender: chat_sender_name(&row.label),
                                text: row.text,
                                truncated: row.cut,
                            })
                            .collect(),
                        truncated,
                    }
                }
            }
        };
        self.restore_chat_panel(&toggle, was_open).await;
        Ok(result)
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
        if self
            .find_control(page, &[STOP_SHARING_PATTERN])
            .await
            .is_some()
        {
            return Ok(ScreenShareOutcome::AlreadySharing);
        }

        self.dismiss_blocking_dialogs(page).await;

        let Some(control) = self.find_control(page, &SHARE_CONTROL_PATTERNS).await else {
            return Ok(ScreenShareOutcome::Failed {
                reason: "I could not find Meet's screen-sharing control.".to_string(),
            });
        };

        if control.click(SHARE_CLICK_TIMEOUT_MS).await.is_err() {
            return Ok(ScreenShareOutcome::Failed {
                reason: "Meet's screen-sharing control would not take a click.".to_string(),
            });
        }

        if let Some(source) = self.find_control(page, &[SHARE_SOURCE_PATTERN]).await {
            // The menu closed itself, or the choice moved. Whether that mattered is
            // decided below, by the room rather than by this click.
            let _ = source.click(SHARE_CLICK_TIMEOUT_MS).await;
        }

        let deadline = now_ms() + SHARE_CONFIRM_TIMEOUT_MS as i64;
        while now_ms() < deadline {
            // Swept on every pass rather than once: the warning lands somewhere inside the
            // renegotiation, and while it is up it covers the presentation.
            if let Some(anyway) = self.find_control(page, &[SELF_VIEW_CONFIRM_PATTERN]).await {
                // A failed click is somebody's click winning the race, or a repaint. The
                // state is read below either way.
                if anyway.click(SHARE_CLICK_TIMEOUT_MS).await.is_ok() {
                    log_info!("[Meeting] Confirmed the self-view warning");
                }
            }

            if self
                .find_control(page, &[STOP_SHARING_PATTERN])
                .await
                .is_some()
            {
                log_info!("[Meeting] Sharing the screen");
                return Ok(ScreenShareOutcome::Sharing);
            }

            page.wait_for_timeout(SHARE_CONFIRM_INTERVAL_MS).await?;
        }

        log_warn!("[Meeting] Asked Meet to share the screen, but it never started presenting");
        Ok(ScreenShareOutcome::Failed {
            reason: "I asked Meet to share the screen and it never started presenting.".to_string(),
        })
    }

    /// Stop presenting.
    ///
    /// The control that shows a share is running is also the control that ends it. So no
    /// control means there is nothing to stop, and the result comes from that control
    /// disappearing rather than from the click.
    async fn stop_screen_share(&self, page: &PageHandle) -> anyhow::Result<ScreenShareOutcome> {
        let Some(stop) = self.find_control(page, &[STOP_SHARING_PATTERN]).await else {
            return Ok(ScreenShareOutcome::NotSharing);
        };

        if stop.click(SHARE_CLICK_TIMEOUT_MS).await.is_err() {
            return Ok(ScreenShareOutcome::Failed {
                reason: "Meet's stop-sharing control would not take a click.".to_string(),
            });
        }

        let deadline = now_ms() + SHARE_CONFIRM_TIMEOUT_MS as i64;
        while now_ms() < deadline {
            if self
                .find_control(page, &[STOP_SHARING_PATTERN])
                .await
                .is_none()
            {
                log_info!("[Meeting] Stopped sharing the screen");
                return Ok(ScreenShareOutcome::Stopped);
            }
            page.wait_for_timeout(SHARE_CONFIRM_INTERVAL_MS).await?;
        }

        log_warn!("[Meeting] Asked Meet to stop sharing, and it is still presenting");
        Ok(ScreenShareOutcome::Failed {
            reason: "I asked Meet to stop sharing and it is still presenting.".to_string(),
        })
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
        // One page read rather than a locator per strategy: this runs on a timer for the
        // whole call, and three locator round-trips each with their own timeout is a lot of
        // work to repeat every ten seconds.
        let readings = with_timeout(
            page.evaluate_function(PARTICIPANT_COUNT_PROBE, json!(null)),
            COUNT_READ_TIMEOUT_MS as i64,
        )
        .await;
        // A closed page, a navigation mid-read, or a page too busy to answer.
        let Ok(serde_json::Value::Array(readings)) = readings else {
            return Ok(None);
        };
        Ok(readings
            .iter()
            .filter_map(serde_json::Value::as_f64)
            .reduce(f64::max)
            .map(|largest| largest as i64))
    }

    /// Click "Leave call" or "Leave meeting" when one appears within two seconds, and log
    /// `[Meeting] Left the call`. Not finding either is not a failure: the browser is closed
    /// immediately after, which drops the WebRTC session and removes the bot from the room
    /// anyway (`[Meeting] No leave button found — closing the browser instead`).
    async fn leave(&self, page: &PageHandle) -> anyhow::Result<()> {
        for source in ["leave call", "leave meeting"] {
            let button = page.get_by_role("button", Some(pattern(source))).first();
            if appears(&button, 2_000).await && button.click(3_000).await.is_ok() {
                log_info!("[Meeting] Left the call");
                return Ok(());
            }
            // Try the other label.
        }
        // Not a failure: the browser is closed immediately after, which drops the
        // WebRTC session and removes the bot from the room anyway.
        log_info!("[Meeting] No leave button found — closing the browser instead");
        Ok(())
    }
}

pub static GOOGLE_MEET_PROVIDER: LazyLock<GoogleMeetProvider> =
    LazyLock::new(GoogleMeetProvider::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::browser_stack::testing::Live;

    #[test]
    fn accepts_a_meet_link_and_rejects_everything_else() {
        let meet = GoogleMeetProvider::new();
        assert!(meet.matches_url("https://meet.google.com/abc-defg-hij"));
        assert!(meet.matches_url("https://meet.google.com/abc-defg-hij?authuser=0"));
        assert!(!meet.matches_url("https://zoom.us/j/123"));
        assert!(!meet.matches_url("https://meet.google.com.evil.example/abc"));
        assert!(!meet.matches_url("http://meet.google.com/abc-defg-hij"));
        assert!(!meet.matches_url("not a url"));
    }

    #[test]
    fn names_itself_for_tools_logs_and_telemetry() {
        let meet = GoogleMeetProvider::new();
        assert_eq!(meet.name(), "google-meet");
        assert_eq!(meet.display_name(), "Google Meet");
    }

    #[test]
    fn reads_the_sender_off_a_chat_group_label() {
        assert_eq!(
            chat_sender_name("Mario Sarcher\n10:42 AM"),
            Some("Mario Sarcher".into())
        );
        // The agent's own messages carry no name, only the time.
        assert_eq!(chat_sender_name("10:42"), None);
        // A group with no time is not one Meet draws a name in.
        assert_eq!(chat_sender_name("Mario Sarcher"), None);
        assert_eq!(chat_sender_name("!\n10.42"), None);
    }

    #[test]
    fn takes_names_in_any_script_but_not_punctuation() {
        assert!(plausible_name("Iris"));
        assert!(plausible_name("山田太郎"));
        assert!(!plausible_name("1"));
        assert!(!plausible_name("--"));
        assert!(!plausible_name(&"a".repeat(41)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn counts_participants_three_ways_and_takes_the_largest() {
        let Some(live) = Live::start().await else {
            return;
        };
        let meet = GoogleMeetProvider::new();
        live.show(r#"<div role="button"><span>People</span><div>3</div></div>"#)
            .await;
        assert_eq!(meet.participant_count(&live.page).await.unwrap(), Some(3));
        live.show(
            r#"<div data-participant-id="a"></div><div data-participant-id="b"></div><div data-participant-id="a"></div>"#,
        )
        .await;
        assert_eq!(meet.participant_count(&live.page).await.unwrap(), Some(2));
        live.show("<p>nothing about people</p>").await;
        assert_eq!(meet.participant_count(&live.page).await.unwrap(), None);
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shares_through_the_source_menu_and_confirms_off_the_stop_control() {
        let Some(live) = Live::start().await else {
            return;
        };
        let meet = GoogleMeetProvider::new();
        live.show(
            r#"<button id="share" onclick="document.getElementById('menu').hidden=false">Share screen</button>
            <div id="menu" hidden><div role="menuitem" onclick="document.getElementById('stop').hidden=false; document.getElementById('menu').hidden=true">Entire screen</div></div>
            <button id="stop" hidden onclick="this.hidden=true">Stop sharing</button>"#,
        )
        .await;
        assert_eq!(
            meet.start_screen_share(&live.page).await.unwrap(),
            ScreenShareOutcome::Sharing
        );
        assert_eq!(
            meet.start_screen_share(&live.page).await.unwrap(),
            ScreenShareOutcome::AlreadySharing
        );
        assert_eq!(
            meet.stop_screen_share(&live.page).await.unwrap(),
            ScreenShareOutcome::Stopped
        );
        assert_eq!(
            meet.stop_screen_share(&live.page).await.unwrap(),
            ScreenShareOutcome::NotSharing
        );
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sets_the_microphone_and_reads_it_back() {
        let Some(live) = Live::start().await else {
            return;
        };
        let meet = GoogleMeetProvider::new();
        live.show(
            r#"<button aria-label="Turn on microphone" data-is-muted="true"
              onclick="const m=this.dataset.isMuted==='true'; this.dataset.isMuted=String(!m); this.setAttribute('aria-label', m ? 'Turn off microphone' : 'Turn on microphone')">mic</button>"#,
        )
        .await;
        assert_eq!(meet.microphone_live(&live.page).await.unwrap(), Some(false));
        assert_eq!(
            meet.set_microphone(&live.page, true).await.unwrap(),
            Some(true)
        );
        // Already in the requested state: no click.
        assert_eq!(
            meet.set_microphone(&live.page, true).await.unwrap(),
            Some(true)
        );
        live.show("<p>no controls</p>").await;
        assert_eq!(meet.set_microphone(&live.page, true).await.unwrap(), None);
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn posts_a_chat_message_and_confirms_it_on_the_page() {
        let Some(live) = Live::start().await else {
            return;
        };
        let meet = GoogleMeetProvider::new();
        live.show(
            r#"<button aria-label="Chat with everyone" aria-expanded="false"
              onclick="const open=this.getAttribute('aria-expanded')==='true'; this.setAttribute('aria-expanded', String(!open)); document.getElementById('panel').hidden=open">chat</button>
            <div id="panel" hidden>
              <div id="list"></div>
              <textarea aria-label="Send a message" onkeydown="if(event.key==='Enter'){event.preventDefault(); const d=document.createElement('div'); d.textContent=this.value; document.getElementById('list').appendChild(d); this.value='';}"></textarea>
            </div>"#,
        )
        .await;
        assert_eq!(
            meet.send_chat_message(&live.page, "https://example.com/doc")
                .await
                .unwrap(),
            ChatSendResult::Sent
        );
        // The panel is closed again after the send.
        assert_eq!(
            live.page
                .evaluate("document.getElementById('panel').hidden")
                .await
                .unwrap(),
            serde_json::json!(true)
        );
        live.show("<p>no chat here</p>").await;
        assert!(matches!(
            meet.send_chat_message(&live.page, "x").await.unwrap(),
            ChatSendResult::NotSent {
                step: ChatSendStep::Panel,
                ..
            }
        ));
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_a_confirmed_rejection_as_a_denial() {
        let Some(live) = Live::start().await else {
            return;
        };
        let meet = GoogleMeetProvider::new();
        live.show("<h1>You can't join this video call</h1>").await;
        assert_eq!(
            meet.confirmed_rejection(&live.page)
                .await
                .unwrap()
                .as_deref(),
            Some(CATCH_ALL_REJECTION)
        );
        live.show("<h1>Ready to join?</h1>").await;
        assert_eq!(meet.confirmed_rejection(&live.page).await.unwrap(), None);
        live.stop().await;
    }
}
