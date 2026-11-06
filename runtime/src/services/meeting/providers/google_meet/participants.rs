//! Who is in the room, and which of them is talking — read from Meet's Participants panel.
//!
//! This replaced a caption scrape, and the reason is worth keeping. Meet already diarises
//! speech for its caption pane, so reading the speaker label off a caption line looked like
//! the obvious route to attribution. Three calls with real participants measured otherwise:
//!
//! - Two people in one room share a stream, and Meet captions them
//!   `"groupsMario Sarcher & 1 others"`. That matches nobody on the roster, so attribution
//!   silently stopped for both of them.
//! - Caption text lags speech by one to two seconds, which put a skew between the speaker
//!   snapshot and the words it was being compared against that no local code could close.
//! - A caption line and a fragment of a sentence are structurally identical, so telling them
//!   apart needed a roster cross-check that existed only to undo the ambiguity.
//!
//! The Participants panel has none of that. Every row has the person's name in its
//! `aria-label`, a per-device `data-participant-id` that is stable for the call, and a voice
//! meter whose class changes as they talk. No lag, no transcription in the path, and nothing
//! that depends on the room's language. A merged-audio cohort is *covered* rather than
//! broken: the members' meters go quiet and a cohort row's meter moves instead, so the answer
//! degrades to one correct group identity.
//!
//! Two things it costs, both real:
//!
//! - **The panel has to be open.** With it shut the list is not in the DOM at all — measured,
//!   not assumed — so `open_participants` is mandatory rather than an optimisation, and a
//!   panel that will not open means no attribution.
//! - **`(You)` and the People control's label are English.** The browser profile is the
//!   agent's own Google account, so its display language is ours to set, but a profile in
//!   another language loses self-detection and the panel toggle. It degrades to no
//!   attribution rather than to wrong attribution.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::services::meeting::browser_stack::PageHandle;
use crate::services::meeting::meeting_provider_interface::{SpeakerDetails, SpeakerReading};

/// One row of the panel, as the page hands it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomParticipant {
    /// Meet's per-device path, or the cohort's own identity for a merged group.
    ///
    /// This, not the name, is what a caller compares. Two people can share a display name and
    /// a display name can change mid-call, so "was that the same person?" has to be answered
    /// on an identity the platform assigns.
    pub id: String,
    pub name: String,
    pub is_self: bool,
    /// True when several people in the room share this one participant row.
    pub is_group: bool,
    /// Whether this row has a voice meter at all.
    ///
    /// Worth reporting because its *absence* is informative: while a shared row is present, the
    /// rows without meters are the people inside it. That is the only signal the panel gives for
    /// who shares the microphone, and it is what lets the agent say "one of Jari or Mario"
    /// instead of reading Meet's own label for the group out loud.
    pub has_meter: bool,
    /// Ages of this row's recent voice-meter transitions, freshest first, empty when it has
    /// not moved since the observer was installed.
    ///
    /// Deliberately raw. One transition is not speech — muting or unmuting swaps the meter
    /// for an icon and changes its class exactly once — so the "is this speech?" rule needs
    /// to see several in quick succession, and that rule belongs in `judge_speaker` where it
    /// can be tested rather than in a page script where it cannot.
    pub meter_hits_ms_ago: Vec<f64>,
}

/// What the meters can currently distinguish.
///
/// `Merged` means at least one row in this call is shared by several people — Meet calls
/// it merged audio, and offers it when it detects people in the same physical room — and
/// it is that row's meter that moves while any of them talks. Not a failure: for a shared
/// microphone one group identity is the true answer rather than a degraded one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomActivity {
    PerPerson,
    Merged,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomReading {
    /// Everyone the panel lists, including the agent itself.
    pub participants: Vec<RoomParticipant>,
    pub activity: RoomActivity,
}

const LIST: &str = "[role=\"list\"][aria-label=\"Participants\"]";
const ROW: &str = "[role=\"listitem\"][aria-label]";

/// The voice meter inside a row.
///
/// `jscontroller` rather than a class name because every class on this subtree is a
/// generated hash. The controller id is generated too, but it survives releases that
/// reshuffle classes, and losing it degrades to no attribution — which
/// `attribution_rate` reports.
const METER: &str = "[jscontroller=\"ES310d\"]";

/// How Meet marks the agent's own row.
const SELF_MARK: &str = "(You)";

/// Longest thing that could be a person's name in the label position.
const MAX_NAME_CHARS: usize = 40;

/// Most recent meter transitions kept per row — enough to tell churn from a single toggle.
const METER_HITS_KEPT: usize = 6;

/// How long to give the panel to render after the control is clicked.
const PANEL_OPEN_MS: u64 = 600;

/// Clicks that opened no list before this gives up for the rest of the call.
///
/// Reachable when Google renames the list while leaving the control findable by `jsname`, or
/// on a profile in another language: the click keeps landing and the list never appears. The
/// runtime would then spend a whole call clicking a live control on every poll, which is the
/// shape the mic path is careful to avoid and this has the same duty.
///
/// Measured, so as not to overstate it: clicking this control while the panel is *already*
/// open left it open — it selects a side panel rather than toggling one — so a stray click is
/// not known to undo the previous one. The bound is here because the cost of being wrong
/// about that is a call spent flicking Meet's UI, and one DOM query is cheap insurance.
const FRUITLESS_OPENS_BEFORE_GIVING_UP: u32 = 3;

/// Cap on one panel read.
///
/// Matches the caption probe this replaced: it runs every second, so a read still
/// outstanding when the next tick is due has already lost the thing it was for.
const READ_TIMEOUT_MS: u64 = 1_500;

/// How recently a meter must have moved for its row to count as speaking now.
///
/// Wide enough to bridge the gaps between words, short enough that it does not still name
/// someone who finished a sentence ago.
const SPEAKING_RECENCY_MS: f64 = 1_200.0;

/// Transitions inside this span are churn — that is, speech rather than a mute toggle.
const SPEECH_CHURN_MS: f64 = 800.0;

/// Fewer than this many transitions in `SPEECH_CHURN_MS` is a state change, not speech.
const SPEECH_CHURN_HITS: usize = 2;

/// Two rows this close together cannot be told apart.
///
/// The audio is one mixed channel, so an utterance overlapping two speakers cannot
/// be attributed to either. Answering nothing leaves the agent saying it cannot tell, which
/// is the safe direction; answering a coin flip would name the wrong person out loud.
const OVERLAP_MS: f64 = 400.0;

/// Open the Participants panel, if it is not already open.
///
/// Idempotent, and cheap when there is nothing to do: the list's presence is the test, so a
/// repeat call is one DOM query. The runtime calls this on every join and keeps calling it
/// while nothing has been attributed, the same shape as unmuting — one unlucky moment while
/// the control bar is still painting would otherwise cost attribution for a whole call,
/// silently.
///
/// Never fails. Attribution is a hint a call runs without, and a panel that refuses to open
/// is not a reason to refuse a meeting.
pub async fn open_participants(page: &PageHandle) {
    todo!()
}

/// Read the panel: every row, and how recently each row's meter moved.
///
/// The meter encodes amplitude, so it passes through its idle value between words. A poll
/// sees only the instant it fires, and at one second apart it lands in those gaps often
/// enough to miss a person talking continuously. A `MutationObserver` sees every transition,
/// so "moved 300ms ago" is exact however slowly the runtime harvests.
///
/// It watches `class` attributes only, and counts a mutation only when the meter is on the
/// path from the mutated node up to the row. Watching `childList` too would catch a Meet
/// release that swaps the meter node instead of restyling it — but it would also fire when
/// anything else in a row changes, and a row re-rendering because somebody joined would read
/// as that person speaking. Precision is the right trade here: a missed transition costs
/// attribution, which the metric shows, while a false one attributes an exchange to the
/// wrong person.
///
/// `None` when the panel is not open or the read failed
/// (`[Meeting] Could not read the participants panel: {err}` at debug).
pub async fn read_room(page: &PageHandle) -> Option<RoomReading> {
    todo!()
}

/// Which row the meters point at, or `None` when they cannot say.
///
/// Pure, and the whole decision — everything the page does is arithmetic. Three ways it
/// answers `None`, all of them "I cannot tell" rather than "nobody":
///
/// - no meter has churned recently, so nobody is talking;
/// - two rows churned within `OVERLAP_MS` of each other, so the mixed channel's utterance
///   belongs to either of them;
/// - the panel offered no meters at all.
///
/// The agent's own row is returned when it is the one talking, with `is_self` set, rather
/// than filtered out. "That was me" and "I cannot tell" are different answers, and a caller
/// that folds them together keeps naming a stale human for as long as the agent speaks.
pub fn judge_speaker(reading: &RoomReading) -> Option<SpeakerReading> {
    if reading.activity == RoomActivity::Unavailable {
        return None;
    }

    let mut speaking: Vec<(&RoomParticipant, f64)> = reading
        .participants
        .iter()
        .filter_map(|p| speech_age(&p.meter_hits_ms_ago).map(|at| (p, at)))
        .collect();
    speaking.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let (first, first_at) = *speaking.first()?;
    if let Some((_, second_at)) = speaking.get(1) {
        if second_at - first_at < OVERLAP_MS {
            return None;
        }
    }

    Some(SpeakerReading {
        id: first.id.clone(),
        is_self: first.is_self,
        who: if first.is_group {
            SpeakerDetails::Group {
                members: shared_microphone_names(Some(reading)),
            }
        } else {
            SpeakerDetails::Person {
                name: first.name.clone(),
            }
        },
    })
}

/// How long ago this row was last *speaking*, as opposed to last changing.
///
/// A single transition is not speech: muting swaps the meter for an icon and changes its
/// class once. Speech churns, so several transitions have to fall inside one short span
/// before the freshest of them counts.
fn speech_age(hits_ms_ago: &[f64]) -> Option<f64> {
    let freshest = *hits_ms_ago.first()?;
    if freshest > SPEAKING_RECENCY_MS {
        return None;
    }

    let churning = hits_ms_ago
        .iter()
        .filter(|age| *age - freshest <= SPEECH_CHURN_MS)
        .count();
    if churning >= SPEECH_CHURN_HITS {
        Some(freshest)
    } else {
        None
    }
}

/// The people sharing one microphone, when the platform is mixing some of the room.
///
/// While a cohort row is present the members are exactly the rows that have an identity but no
/// meter of their own — Meet moves the meter to the group. Empty when nothing is merged, which
/// is the common case.
///
/// This exists so nobody has to say "Merged audio" to a human. That is Meet's label for its own
/// UI, and an agent that reads it out is naming somebody who does not exist; naming the two
/// people who actually share the microphone is both true and useful.
pub fn shared_microphone_names(reading: Option<&RoomReading>) -> Vec<String> {
    let Some(reading) = reading else {
        return Vec::new();
    };
    if reading.activity != RoomActivity::Merged {
        return Vec::new();
    }
    reading
        .participants
        .iter()
        .filter(|p| !p.is_group && !p.is_self && !p.has_meter)
        .map(|p| p.name.clone())
        .collect()
}

/// The other people in the room. Empty when the panel could not be read.
///
/// Two exclusions, and both of them leaked before they were here.
///
/// A **shared row's label is not a person.** "Merged audio" passes every plausibility test a
/// name has to pass, and it reaches three places that each do the wrong thing with it: the
/// transcriber takes it as a decoding hint and biases recognition toward the phrase, the model
/// is told it is somebody in the call and may greet it, and the addressed gate is handed it as
/// somebody an utterance could have been aimed at. `is_group` exists so nothing says "Merged
/// audio" as though it were somebody, and honouring it only on the speaker path left the
/// roster path saying it anyway — in exactly the merged-audio call this read exists to cover.
///
/// The **agent's own row** is excluded here rather than by name further downstream, because the
/// Google account's display name need not match the agent's own. A renamed agent would seed its
/// own account name into the transcriber's keywords and be reported to itself as a participant
/// in the room; `is_self` is read off the panel and cannot disagree with itself that way.
pub fn names_from(reading: Option<&RoomReading>) -> Vec<String> {
    let Some(reading) = reading else {
        return Vec::new();
    };

    // Case-insensitively unique, keeping the first spelling. Not hypothetical: a live call with
    // merged audio listed the same person twice and sent the transcriber
    // `keywords=[…, Maximilian Greis, Maximilian Greis, …]`, spending two of its twelve slots on
    // one name and telling the model there was an extra person in the room. The reading this
    // replaced deduped for the same reason — two scrapes of one person — and dropping it when the
    // roster moved to a single source was a regression rather than a simplification, because one
    // source can still list one person twice.
    let mut seen: IndexMap<String, String> = IndexMap::new();
    for p in &reading.participants {
        if p.is_group || p.is_self {
            continue;
        }
        seen.entry(p.name.to_lowercase())
            .or_insert_with(|| p.name.clone());
    }
    seen.into_values().collect()
}
