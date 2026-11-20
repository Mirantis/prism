//! Should the agent answer *this* utterance?
//!
//! The Realtime API can decide that for us — `turn_detection.create_response`
//! opens a response at the end of every utterance — and in a room with more than
//! one human that is exactly wrong: the meeting audio is a single mixed channel,
//! so "someone finished a sentence" says nothing about who they were talking to.
//! A call with three people in it had the agent answering questions the humans
//! were asking each other.
//!
//! So the server never creates responses on its own (`create_response: false`)
//! and this object decides instead. Two modes, chosen from the participant count:
//!
//! - **open** — one human in the room, so everything said is said to the agent.
//!   It answers on end-of-utterance, which is the same instant the server would
//!   have created the response itself, so a one-to-one call is no slower than it
//!   was with the API driving.
//! - **addressed** — more than one human, so most of what is said is not for the
//!   agent. Which utterances are is decided by `addressed_audio_gate.rs`, which asks
//!   the meeting model about the one it just heard. Not by matching a string: an
//!   agent can be called anything, and a name can be mentioned without being
//!   addressed ("I asked Prism about that yesterday").
//!
//! Deliberately *not* judged: whether a sentence merely sounds like a request for
//! an assistant. The room is one mixed channel with no speaker labels, so "can you
//! add apples to the list?" is identical whether it was said to the agent or to the
//! person in the next chair. Guessing there is how a meeting bot ends up in the
//! middle of other people's conversations.
//!
//! **No clock decides a follow-up.** An earlier version kept a 15-second window in
//! which any utterance counted as addressed, so a follow-up needn't repeat the name.
//! Real calls killed it: fifteen seconds after the agent stops talking is mostly
//! other people starting to talk to *each other*, and a window cannot tell those
//! apart from a genuine follow-up. Nothing here replaced it — an unnamed follow-up
//! is answered, but because the gate can *see* the exchange it belongs to, which is
//! a judgement rather than a grace period. This object holds no timers.
//!
//! Every "yes" from this object *will* be spoken: unlike prompt-level gating there
//! is no path for the model to decline once `response.create` goes out. That makes
//! false positives the failure mode to design against.

use serde::{Deserialize, Serialize};

use crate::lib::inference_gate::INFERENCE_GATE;
use crate::log_info;

/// What the caller asked for. `auto` resolves from the participant count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseMode {
    Auto,
    Open,
    Addressed,
}

impl ResponseMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ResponseMode::Auto => "auto",
            ResponseMode::Open => "open",
            ResponseMode::Addressed => "addressed",
        }
    }
}

/// What the policy is actually doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveMode {
    Open,
    Addressed,
}

impl EffectiveMode {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectiveMode::Open => "open",
            EffectiveMode::Addressed => "addressed",
        }
    }
}

/// What to do with an utterance the turn detector has just closed.
///
/// `Gate` means this object declines to decide: whether the agent was addressed is
/// a judgement made from the audio by a model, and judgements cannot live in a
/// type the rest of the code calls synchronously.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnDecision {
    Respond,
    Gate,
    Ignore,
}

/// Item ids remembered for the duplicate check. Bounded; turns are short-lived.
const HANDLED_ITEM_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy)]
pub struct ResponsePolicyOptions {
    pub mode: ResponseMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePolicyStats {
    /// Utterances the room produced (committed by the turn detector).
    pub utterances: i64,
    /// Of those, the ones the agent answered.
    pub answered: i64,
    /// Of those, the ones it stayed quiet through.
    pub suppressed: i64,
    /// Answers in `addressed` mode — times the agent was called by name.
    pub addressed_matches: i64,
    /// How often the effective mode changed during the call.
    ///
    /// Usually people joining or leaving, but a call the agent cannot be heard in also
    /// holds it in `addressed` — counted the same, because the two paths can each undo the
    /// other and a tally that saw only one of them would report an odd number of switches
    /// for a call that ended in the mode it started in.
    pub mode_switches: i64,
}

#[derive(Debug, Clone)]
pub struct ResponsePolicy {
    options: ResponsePolicyOptions,
    /// Starts `addressed` rather than `open` when nothing is known yet.
    ///
    /// A count arrives moments after admission, so this covers a scraper that can't
    /// read the UI at all. Guessing `open` there would put the original bug back in
    /// a full room; guessing `addressed` costs a one-to-one caller one spoken name.
    mode: EffectiveMode,
    /// Whether the room can hear the agent at all.
    ///
    /// Only `open` mode cares. `open` answers every utterance at its turn boundary,
    /// which is right when one human is talking to the agent and ruinous when nothing
    /// the agent says arrives: a full Realtime response per sentence, for the length of
    /// the call, all of it billed and none of it heard. `addressed` is already bounded
    /// by somebody choosing to say the agent's name, and staying responsive there is
    /// deliberate — a muted agent still *acts* on what it is asked, and the action lands
    /// even when the confirmation does not.
    audible: bool,
    /// Utterances a decision has been taken on, verdict or not.
    ///
    /// Two lists rather than one because the states are different questions: a claimed
    /// utterance must not be judged again, while a *decided* one must not be answered
    /// again. Collapsing them would either let a duplicate commit spend a second probe
    /// or stop the first verdict from ever being applied.
    claimed_items: Vec<String>,
    decided_items: Vec<String>,
    stats: ResponsePolicyStats,
}

impl ResponsePolicy {
    pub fn new(options: ResponsePolicyOptions) -> Self {
        let mode = match options.mode {
            ResponseMode::Open => EffectiveMode::Open,
            ResponseMode::Addressed | ResponseMode::Auto => EffectiveMode::Addressed,
        };
        Self {
            options,
            mode,
            audible: true,
            claimed_items: Vec::new(),
            decided_items: Vec::new(),
            stats: ResponsePolicyStats::default(),
        }
    }

    pub fn effective_mode(&self) -> EffectiveMode {
        self.mode
    }

    pub fn statistics(&self) -> ResponsePolicyStats {
        self.stats
    }

    /// The mode the policy was built with, as an effective mode, when it is not `auto`.
    fn explicit_mode(&self) -> Option<EffectiveMode> {
        match self.options.mode {
            ResponseMode::Auto => None,
            ResponseMode::Open => Some(EffectiveMode::Open),
            ResponseMode::Addressed => Some(EffectiveMode::Addressed),
        }
    }

    /// Say whether the room can hear the agent.
    ///
    /// Gates the *transition* into `open` rather than filtering its decisions, so
    /// `mode` stays the one answer to "how am I behaving" and nothing downstream has to
    /// ask a second question. Recovery restores whatever the mode would have been: an
    /// `auto` policy gets it back from the next count reading seconds later, an explicit
    /// one from the option it was built with.
    pub fn set_audible(&mut self, audible: bool) {
        if audible == self.audible {
            return;
        }
        self.audible = audible;

        if !audible {
            if self.mode == EffectiveMode::Open {
                self.mode = EffectiveMode::Addressed;
                self.stats.mode_switches += 1;
                log_info!(
                    "[Meeting] Nothing I say is reaching the room — answering only when addressed"
                );
            }
            return;
        }

        if let Some(explicit) = self.explicit_mode()
            && self.mode != explicit
        {
            self.mode = explicit;
            self.stats.mode_switches += 1;
            log_info!(
                "[Meeting] The room can hear me again — back to \"{}\" mode",
                self.mode.as_str()
            );
        }
    }

    /// Take a participant-count reading (including the agent itself).
    ///
    /// `None` means the UI could not be read, which is never a reason to change
    /// behaviour — the last known mode stands. Ignored entirely unless the caller
    /// asked for `auto`.
    pub fn set_participant_count(&mut self, count: Option<i64>) {
        let Some(count) = count else { return };
        if self.options.mode != ResponseMode::Auto {
            return;
        }
        // Nothing the agent says is arriving, so `open` would answer a room that hears
        // none of it. Held here rather than at the decision sites so `mode` remains the
        // single description of how the agent is behaving.
        if !self.audible {
            return;
        }

        // The agent is one of them, so two means one human: everything said in the
        // room is said to the agent.
        let next = if count <= 2 {
            EffectiveMode::Open
        } else {
            EffectiveMode::Addressed
        };
        if next == self.mode {
            return;
        }

        self.mode = next;
        self.stats.mode_switches += 1;
        log_info!(
            "[Meeting] {} participant(s) — answering {}",
            count,
            if next == EffectiveMode::Open {
                "everything said in the room"
            } else {
                "only when addressed"
            }
        );
    }

    /// The turn detector closed an utterance — the one moment a turn is decided.
    ///
    /// `Respond` in a one-to-one call, where there is nothing to decide: the answer
    /// starts at the same instant the server would have started it. `Gate` otherwise,
    /// meaning "ask the model whether this was aimed at us". `Ignore` for an utterance
    /// this has already taken a decision on.
    ///
    /// An utterance is claimed here, before its verdict exists, and that is the point.
    /// Remembering it only once a verdict said *yes* left three holes: a duplicated
    /// commit arriving while the first probe was still in flight launched a second
    /// probe, two no-verdicts on one utterance counted it twice in both `utterances`
    /// and `suppressed`, and a no followed by a yes could answer a sentence the gate
    /// had already declined. Either verdict is terminal now, so each utterance is
    /// decided exactly once.
    pub fn on_utterance_committed(&mut self, item_id: &str) -> TurnDecision {
        // A secure takeover of the computer stops the runtime, and the session refuses to
        // answer while it lasts (`realtime_session.rs`). Declining here as well spends no
        // probe judging an utterance that cannot be answered.
        if INFERENCE_GATE.held() {
            return TurnDecision::Ignore;
        }
        if self.is_claimed(item_id) {
            return TurnDecision::Ignore;
        }
        self.claim(item_id);
        self.stats.utterances += 1;
        if self.mode != EffectiveMode::Open {
            return TurnDecision::Gate;
        }
        // Answering here *is* the decision, so record it as one. A verdict can still
        // arrive for this utterance — the mode may have been `addressed` when the probe
        // went out and flipped to `open` before the turn closed — and it must not add a
        // second answer.
        self.decide(item_id);
        self.stats.answered += 1;
        TurnDecision::Respond
    }

    /// Apply the verdict on whether the agent was addressed.
    ///
    /// Re-checks that this utterance is still awaiting one rather than trusting the
    /// caller: a verdict arrives a few hundred milliseconds after the utterance
    /// closed, the room does not wait, and a retried or duplicated probe can answer
    /// twice. The first verdict to arrive decides, whichever way it goes.
    pub fn resolve_verdict(&mut self, item_id: &str, addressed: bool) -> bool {
        if self.is_decided(item_id) {
            return false;
        }
        self.decide(item_id);

        if !addressed {
            self.stats.suppressed += 1;
            return false;
        }

        self.stats.addressed_matches += 1;
        self.stats.answered += 1;
        log_info!("[Meeting] Addressed — responding");
        true
    }

    /// Claimed: a decision has been taken, whether or not a verdict has landed.
    fn is_claimed(&self, item_id: &str) -> bool {
        !item_id.is_empty() && self.claimed_items.iter().any(|id| id == item_id)
    }

    /// Decided: a verdict has been applied, so no later one may.
    fn is_decided(&self, item_id: &str) -> bool {
        !item_id.is_empty() && self.decided_items.iter().any(|id| id == item_id)
    }

    fn claim(&mut self, item_id: &str) {
        Self::remember(&mut self.claimed_items, item_id);
    }

    fn decide(&mut self, item_id: &str) {
        Self::remember(&mut self.decided_items, item_id);
    }

    fn remember(items: &mut Vec<String>, item_id: &str) {
        if item_id.is_empty() {
            return;
        }
        items.push(item_id.to_string());
        if items.len() > HANDLED_ITEM_LIMIT {
            items.remove(0);
        }
    }
}

/// The gate that decides whether an utterance in the room becomes speech.
///
/// Everything here is about false positives: a "yes" from this object always reaches the
/// room, because once `response.create` goes out the model has no way to decline. So the
/// tests that matter most are the ones asserting silence.
#[cfg(test)]
mod tests {
    use super::*;

    fn policy(mode: ResponseMode) -> ResponsePolicy {
        ResponsePolicy::new(ResponsePolicyOptions { mode })
    }

    fn auto() -> ResponsePolicy {
        policy(ResponseMode::Auto)
    }

    fn crowded() -> ResponsePolicy {
        let mut p = auto();
        p.set_participant_count(Some(4));
        p
    }

    #[test]
    fn answers_everything_when_there_is_one_other_person() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        assert_eq!(p.effective_mode(), EffectiveMode::Open);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Respond);
    }

    #[test]
    fn asks_the_gate_once_a_third_person_joins() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        p.set_participant_count(Some(3));
        assert_eq!(p.effective_mode(), EffectiveMode::Addressed);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
    }

    #[test]
    fn assumes_a_crowd_until_it_has_been_told_otherwise() {
        assert_eq!(auto().effective_mode(), EffectiveMode::Addressed);
    }

    #[test]
    fn keeps_the_current_mode_when_the_count_cannot_be_read() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        p.set_participant_count(None);
        assert_eq!(p.effective_mode(), EffectiveMode::Open);
        assert_eq!(p.statistics().mode_switches, 1);
    }

    #[test]
    fn ignores_the_room_when_a_mode_was_asked_for_explicitly() {
        let mut p = policy(ResponseMode::Addressed);
        p.set_participant_count(Some(2));
        assert_eq!(p.effective_mode(), EffectiveMode::Addressed);
    }

    #[test]
    fn counts_a_switch_only_when_the_mode_actually_changes() {
        let mut p = auto();
        p.set_participant_count(Some(5));
        p.set_participant_count(Some(6));
        assert_eq!(p.statistics().mode_switches, 0);
    }

    #[test]
    fn stops_answering_everything_when_nobody_can_hear_it() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        assert_eq!(p.effective_mode(), EffectiveMode::Open);
        p.set_audible(false);
        assert_eq!(p.effective_mode(), EffectiveMode::Addressed);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
    }

    #[test]
    fn does_not_drift_back_into_open_mode_on_the_next_count_reading() {
        let mut p = auto();
        p.set_audible(false);
        p.set_participant_count(Some(2));
        assert_eq!(p.effective_mode(), EffectiveMode::Addressed);
    }

    #[test]
    fn goes_back_to_open_mode_once_the_room_can_hear_it_again() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        p.set_audible(false);
        p.set_audible(true);
        p.set_participant_count(Some(2));
        assert_eq!(p.effective_mode(), EffectiveMode::Open);
    }

    #[test]
    fn restores_a_mode_that_was_asked_for_explicitly() {
        let mut p = policy(ResponseMode::Open);
        p.set_audible(false);
        assert_eq!(p.effective_mode(), EffectiveMode::Addressed);
        p.set_audible(true);
        assert_eq!(p.effective_mode(), EffectiveMode::Open);
    }

    #[test]
    fn still_answers_when_it_is_addressed_by_name_while_inaudible() {
        let mut p = auto();
        p.set_participant_count(Some(4));
        p.set_audible(false);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
    }

    #[test]
    fn answers_when_the_model_says_the_utterance_was_for_the_agent() {
        let mut p = crowded();
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
        assert!(p.resolve_verdict("i1", true));
        assert_eq!(p.statistics().addressed_matches, 1);
    }

    #[test]
    fn stays_quiet_when_the_model_says_it_was_not() {
        let mut p = crowded();
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
        assert!(!p.resolve_verdict("i1", false));
        assert_eq!(p.statistics().suppressed, 1);
        assert_eq!(p.statistics().answered, 0);
    }

    #[test]
    fn drops_a_second_verdict_for_an_utterance_already_answered() {
        let mut p = crowded();
        assert!(p.resolve_verdict("i1", true));
        assert!(!p.resolve_verdict("i1", true));
        assert_eq!(p.statistics().answered, 1);
    }

    #[test]
    fn ignores_an_utterance_the_boundary_already_answered() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Respond);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Ignore);
        assert_eq!(p.statistics().answered, 1);
    }

    #[test]
    fn does_not_spend_a_second_probe_on_a_duplicated_commit() {
        let mut p = crowded();
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Ignore);
        assert_eq!(p.statistics().utterances, 1);
    }

    #[test]
    fn makes_a_no_terminal_so_a_later_yes_cannot_answer_it() {
        let mut p = crowded();
        p.on_utterance_committed("i1");
        assert!(!p.resolve_verdict("i1", false));
        assert!(!p.resolve_verdict("i1", true));
        assert_eq!(p.statistics().answered, 0);
        assert_eq!(p.statistics().suppressed, 1);
    }

    #[test]
    fn counts_one_suppression_per_utterance_not_one_per_verdict() {
        let mut p = crowded();
        p.on_utterance_committed("i1");
        p.resolve_verdict("i1", false);
        p.resolve_verdict("i1", false);
        assert_eq!(p.statistics().suppressed, 1);
        assert_eq!(p.statistics().utterances, 1);
    }

    #[test]
    fn needs_the_name_every_time_with_no_grace_period_after_it_speaks() {
        let mut p = crowded();
        assert!(p.resolve_verdict("i1", true));
        assert_eq!(p.on_utterance_committed("i2"), TurnDecision::Gate);
    }

    #[test]
    fn answers_an_id_less_utterance_in_open_mode() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        assert_eq!(p.on_utterance_committed(""), TurnDecision::Respond);
    }

    #[test]
    fn still_puts_an_id_less_utterance_to_the_gate_in_a_crowd() {
        let mut p = auto();
        p.set_participant_count(Some(4));
        assert_eq!(p.on_utterance_committed(""), TurnDecision::Gate);
    }

    #[test]
    fn counts_every_utterance_the_room_produced_answered_or_not() {
        let mut p = policy(ResponseMode::Addressed);
        p.on_utterance_committed("i1");
        p.on_utterance_committed("i2");
        p.resolve_verdict("i1", true);
        p.resolve_verdict("i2", false);
        assert_eq!(p.statistics().utterances, 2);
        assert_eq!(p.statistics().answered, 1);
        assert_eq!(p.statistics().suppressed, 1);
    }

    #[test]
    fn counts_an_answer_once_however_many_verdicts_arrive() {
        let mut p = policy(ResponseMode::Addressed);
        assert!(p.resolve_verdict("i1", true));
        assert!(!p.resolve_verdict("i1", true));
        assert_eq!(p.statistics().answered, 1);
        assert_eq!(p.statistics().addressed_matches, 1);
    }

    #[test]
    fn still_answers_someone_who_used_the_name_as_the_room_emptied() {
        let mut p = auto();
        p.set_participant_count(Some(4));
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Gate);
        p.set_participant_count(Some(2));
        assert!(p.resolve_verdict("i1", true));
    }

    #[test]
    fn does_not_answer_twice_when_the_room_filled_instead() {
        let mut p = auto();
        p.set_participant_count(Some(2));
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Respond);
        p.set_participant_count(Some(4));
        assert!(!p.resolve_verdict("i1", true));
    }

    #[test]
    #[serial_test::serial(inference_gate)]
    fn keeps_the_agent_quiet_during_a_secure_takeover_of_the_computer() {
        let mut p = policy(ResponseMode::Open);
        INFERENCE_GATE.hold();
        // Not even claimed: the utterance is not the agent's to decide while somebody is
        // typing a password on its desktop.
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Ignore);
        assert_eq!(p.statistics().utterances, 0);
        INFERENCE_GATE.free();
        assert_eq!(p.on_utterance_committed("i1"), TurnDecision::Respond);
    }
}
