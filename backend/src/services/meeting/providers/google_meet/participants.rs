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
use serde_json::json;

use crate::services::meeting::browser_stack::PageHandle;
use crate::services::meeting::meeting_provider_interface::{SpeakerDetails, SpeakerReading};
use crate::utils::with_timeout::with_timeout;
use crate::{log_debug, log_info};

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
    let outcome = with_timeout(
        page.evaluate_function(
            OPEN_PANEL_PROBE,
            json!({
                "list": LIST,
                "settleMs": PANEL_OPEN_MS,
                "giveUpAfter": FRUITLESS_OPENS_BEFORE_GIVING_UP,
            }),
        ),
        (READ_TIMEOUT_MS + PANEL_OPEN_MS) as i64,
    )
    .await;

    match outcome {
        Ok(outcome) => match outcome.as_str() {
            Some("opened") => {
                log_info!("[Meeting] Opened the participants panel, so I can tell who is speaking");
            }
            Some("no-list") => {
                log_debug!("[Meeting] Clicked the participants control but no list appeared");
            }
            Some("gave-up") => {
                log_debug!(
                    "[Meeting] Not clicking the participants control again — it opens no list"
                );
            }
            _ => {}
        },
        Err(err) => {
            log_debug!(
                "[Meeting] Could not open the participants panel: Error: {}",
                err
            );
        }
    }
}

/// The page half of `open_participants`: `open`, `opened`, `no-list`, `no-control` or
/// `gave-up`.
const OPEN_PANEL_PROBE: &str = r#"async ({ list, settleMs, giveUpAfter }) => {
  const w = globalThis;
  const doc = w.document;
  if (doc.querySelector(list)) return 'open';

  const tries = (w.__prismPanel ??= { fruitless: 0 });
  if (tries.fruitless >= giveUpAfter) return 'gave-up';

  // The control has its name as *text* — "People" plus a count badge, so
  // "People2" — and has no aria-label of its own. Matched on that text, with the
  // jsname as a second try, because between an English word and a minified
  // identifier neither is clearly the more durable of the two.
  const byText = Array.from(doc.querySelectorAll('[role="button"]')).find((el) =>
    /^people\s*\d*$/i.test(el.textContent?.trim() ?? ''),
  );
  const control = byText ?? doc.querySelector('[jsname="ocqpFe"]');
  if (!control) return 'no-control';

  control.click();
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  // Checked rather than assumed, because the click is the cheap half: what has to be
  // true afterwards is that the list is *there*.
  if (doc.querySelector(list)) {
    tries.fruitless = 0;
    return 'opened';
  }
  tries.fruitless += 1;
  return 'no-list';
}"#;

/// The page half of `read_room`: the rows, and the meter transitions the observer saw.
const READ_ROOM_PROBE: &str = r#"({ list, row, meter, selfMark, maxNameChars, hitsKept }) => {
  const w = globalThis;

  const panel = w.document.querySelector(list);
  if (!panel) return null;

  const identify = (el) =>
    el.getAttribute('data-participant-id') ??
    el.getAttribute('data-cohort-id') ??
    el.getAttribute('aria-label') ??
    '';

  // Re-installed whenever the list this was attached to is gone: an observer on a
  // detached node keeps its callback and never fires again, so trusting a previous
  // install would report a silent room for the rest of the call.
  let state = w.__prismRoom;
  if (!state || state.list !== panel || !state.list.isConnected) {
    state?.observer.disconnect();
    const hits = new Map();
    const observer = new w.MutationObserver((records) => {
      const at = Date.now();
      for (let i = 0; i < records.length; i++) {
        let node = records[i].target;
        let sawMeter = false;
        while (node && node !== panel) {
          if (!sawMeter && node.matches(meter)) sawMeter = true;
          if (node.matches(row)) break;
          node = node.parentElement;
        }
        if (!sawMeter || !node || node === panel) continue;

        const key = identify(node);
        if (!key) continue;
        const seen = hits.get(key) ?? [];
        seen.unshift(at);
        if (seen.length > hitsKept) seen.length = hitsKept;
        hits.set(key, seen);
      }
    });
    observer.observe(panel, { subtree: true, attributes: true, attributeFilter: ['class'] });
    state = { hits, observer, list: panel };
    w.__prismRoom = state;
  }

  const now = Date.now();
  const participants = [];
  let meteredWithId = 0;
  let meteredWithoutId = 0;

  for (const el of Array.from(panel.querySelectorAll(row))) {
    const name = el.getAttribute('aria-label')?.trim() ?? '';
    const id = identify(el);
    if (!id || name.length === 0 || name.length > maxNameChars) continue;

    const hasMeter = el.querySelector(meter) !== null;
    if (hasMeter) {
      if (el.getAttribute('data-participant-id')) meteredWithId += 1;
      else meteredWithoutId += 1;
    }

    participants.push({
      id,
      name,
      isSelf: (el.textContent ?? '').includes(selfMark),
      // A row with no `data-participant-id` is a shared one. That attribute is a
      // *device* path, and a merged row stands for no single device — in the live
      // merged-audio call these probes were written against it carried
      // `data-cohort-id` instead, while the people inside it kept their own rows
      // and their own ids and lost only their meters.
      isGroup: !el.getAttribute('data-participant-id'),
      hasMeter,
      meterHitsMsAgo: (state.hits.get(id) ?? []).map((at) => now - at),
    });
  }

  // A metered row with no participant id is a cohort: several people Meet is
  // mixing into one stream, whose own members' meters have gone quiet.
  const activity =
    meteredWithoutId > 0 ? 'merged' : meteredWithId > 0 ? 'per-person' : 'unavailable';

  return { participants, activity };
}"#;

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
    let read = with_timeout(
        page.evaluate_function(
            READ_ROOM_PROBE,
            json!({
                "list": LIST,
                "row": ROW,
                "meter": METER,
                "selfMark": SELF_MARK,
                "maxNameChars": MAX_NAME_CHARS,
                "hitsKept": METER_HITS_KEPT,
            }),
        ),
        READ_TIMEOUT_MS as i64,
    )
    .await
    .and_then(|value| Ok(serde_json::from_value::<Option<RoomReading>>(value)?));

    match read {
        Ok(reading) => reading,
        Err(err) => {
            log_debug!(
                "[Meeting] Could not read the participants panel: Error: {}",
                err
            );
            None
        }
    }
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
    if let Some((_, second_at)) = speaking.get(1)
        && second_at - first_at < OVERLAP_MS
    {
        return None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::browser_stack::testing::Live;

    fn row(name: &str, hits: &[f64]) -> RoomParticipant {
        RoomParticipant {
            id: format!("d/{name}"),
            name: name.to_string(),
            is_self: false,
            is_group: false,
            has_meter: true,
            meter_hits_ms_ago: hits.to_vec(),
        }
    }

    fn reading(participants: Vec<RoomParticipant>, activity: RoomActivity) -> RoomReading {
        RoomReading {
            participants,
            activity,
        }
    }

    #[test]
    fn names_the_row_whose_meter_is_moving() {
        let verdict = judge_speaker(&reading(
            vec![row("Iris", &[]), row("Mario", &[40.0, 300.0])],
            RoomActivity::PerPerson,
        ));
        assert_eq!(
            verdict,
            Some(SpeakerReading {
                id: "d/Mario".into(),
                is_self: false,
                who: SpeakerDetails::Person {
                    name: "Mario".into()
                },
            })
        );
    }

    #[test]
    fn treats_a_single_transition_as_a_state_change_not_speech() {
        // Muting swaps the meter for an icon and changes its class exactly once.
        let verdict = judge_speaker(&reading(
            vec![row("Mario", &[40.0])],
            RoomActivity::PerPerson,
        ));
        assert_eq!(verdict, None);
    }

    #[test]
    fn declines_when_two_rows_are_talking_at_once() {
        let verdict = judge_speaker(&reading(
            vec![row("Iris", &[30.0, 200.0]), row("Mario", &[60.0, 250.0])],
            RoomActivity::PerPerson,
        ));
        assert_eq!(verdict, None);
    }

    #[test]
    fn names_the_fresher_of_two_rows_once_they_are_clearly_apart() {
        let verdict = judge_speaker(&reading(
            vec![row("Iris", &[30.0, 200.0]), row("Mario", &[700.0, 900.0])],
            RoomActivity::PerPerson,
        ));
        assert_eq!(
            verdict.map(|v| v.who),
            Some(SpeakerDetails::Person {
                name: "Iris".into()
            })
        );
    }

    #[test]
    fn declines_a_meter_that_stopped_moving_a_while_ago() {
        let verdict = judge_speaker(&reading(
            vec![row("Mario", &[3_000.0, 3_200.0])],
            RoomActivity::PerPerson,
        ));
        assert_eq!(verdict, None);
    }

    #[test]
    fn declines_when_the_platform_offers_no_meters_at_all() {
        let verdict = judge_speaker(&reading(
            vec![row("Mario", &[40.0, 300.0])],
            RoomActivity::Unavailable,
        ));
        assert_eq!(verdict, None);
    }

    #[test]
    fn reports_the_agent_itself_rather_than_nobody() {
        let mut me = row("Iris", &[40.0, 300.0]);
        me.is_self = true;
        let verdict = judge_speaker(&reading(vec![me], RoomActivity::PerPerson)).unwrap();
        assert!(verdict.is_self);
        assert_eq!(
            verdict.who,
            SpeakerDetails::Person {
                name: "Iris".into()
            }
        );
    }

    #[test]
    fn reports_a_merged_cohort_as_a_group_and_names_who_shares_the_microphone() {
        let mut group = row("Merged audio", &[40.0, 300.0]);
        group.is_group = true;
        let mut jari = row("Jari", &[]);
        jari.has_meter = false;
        let mut mario = row("Mario Sarcher", &[]);
        mario.has_meter = false;
        let verdict = judge_speaker(&reading(
            vec![group, jari, mario, row("Prismith", &[])],
            RoomActivity::Merged,
        ));
        assert_eq!(
            verdict.map(|v| v.who),
            Some(SpeakerDetails::Group {
                members: vec!["Jari".into(), "Mario Sarcher".into()]
            })
        );
    }

    #[test]
    fn names_nobody_as_sharing_a_microphone_when_nothing_is_merged() {
        let plain = reading(vec![row("Jari", &[40.0, 300.0])], RoomActivity::PerPerson);
        assert!(shared_microphone_names(Some(&plain)).is_empty());
        assert!(shared_microphone_names(None).is_empty());
    }

    #[test]
    fn lists_a_person_once_however_many_rows_the_panel_gives_them() {
        let roster = reading(
            vec![
                row("Maximilian Greis", &[]),
                row("maximilian greis", &[]),
                row("Jari", &[]),
            ],
            RoomActivity::PerPerson,
        );
        assert_eq!(
            names_from(Some(&roster)),
            vec!["Maximilian Greis".to_string(), "Jari".to_string()]
        );
    }

    const PANEL: &str = r#"
      <div role="list" aria-label="Participants">
        <div role="listitem" aria-label="Iris" data-participant-id="spaces/_CtC/devices/244">
          <span>Iris(You)</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
        </div>
        <div role="listitem" aria-label="Mario Sarcher" data-participant-id="spaces/_CtC/devices/235">
          <span>Mario Sarcher</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
        </div>
      </div>"#;

    const MERGED_PANEL: &str = r#"
      <div role="list" aria-label="Participants">
        <div role="listitem" aria-label="Iris" data-participant-id="spaces/_CtC/devices/244">
          <span>Iris(You)</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
        </div>
        <div role="listitem" aria-label="Merged audio">
          <span>Merged audio</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
        </div>
        <div role="listitem" aria-label="Mario Sarcher" data-participant-id="spaces/_CtC/devices/235">
          <span>Mario Sarcher</span>
        </div>
      </div>"#;

    #[tokio::test(flavor = "multi_thread")]
    async fn reads_the_panel_off_a_real_page() {
        let Some(live) = Live::start().await else {
            return;
        };
        let page = &live.page;

        // With the panel shut the list is not in the page at all.
        live.show("<div>call in progress</div>").await;
        assert_eq!(read_room(page).await, None);

        live.show(PANEL).await;
        let room = read_room(page).await.unwrap();
        assert_eq!(room.activity, RoomActivity::PerPerson);
        assert_eq!(
            room.participants[0],
            RoomParticipant {
                id: "spaces/_CtC/devices/244".into(),
                name: "Iris".into(),
                is_self: true,
                is_group: false,
                has_meter: true,
                meter_hits_ms_ago: vec![],
            }
        );
        assert_eq!(names_from(Some(&room)), vec!["Mario Sarcher".to_string()]);

        // A meter churning is recorded on its own row only.
        page.evaluate(
            "(() => { const m = document.querySelector('[aria-label=\"Mario Sarcher\"] [jscontroller=\"ES310d\"]'); m.setAttribute('class', 'IisKdb Oaajhc'); m.setAttribute('class', 'IisKdb wEsLMd'); })()",
        )
        .await
        .unwrap();
        let room = read_room(page).await.unwrap();
        assert_eq!(room.participants[1].meter_hits_ms_ago.len(), 2);
        assert!(room.participants[0].meter_hits_ms_ago.is_empty());

        live.show(MERGED_PANEL).await;
        let room = read_room(page).await.unwrap();
        assert_eq!(room.activity, RoomActivity::Merged);
        assert!(room.participants[1].is_group);
        assert_eq!(room.participants[1].id, "Merged audio");
        assert_eq!(names_from(Some(&room)), vec!["Mario Sarcher".to_string()]);
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn opens_the_panel_and_stops_clicking_a_control_that_opens_nothing() {
        let Some(live) = Live::start().await else {
            return;
        };
        let page = &live.page;
        live.show(
            r#"<div role="button" onclick="window.clicks = (window.clicks || 0) + 1"><span>People</span><div>2</div></div>"#,
        )
        .await;
        for _ in 0..5 {
            open_participants(page).await;
        }
        // Three fruitless clicks, then it gives up for the rest of the call.
        assert_eq!(
            page.evaluate("window.clicks").await.unwrap(),
            serde_json::json!(3)
        );
        live.stop().await;
    }
}
