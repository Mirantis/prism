//! Numbers derived from a voice session's gate counters.
//!
//! Its own module because both session owners emit these under the same telemetry keys,
//! and a sum in one event and a mean in the other are incomparable while looking like one
//! metric.
//!
//! The stats type is imported for its shape only, so nothing here depends on the session.

use crate::services::meeting::voice_conversation::VoiceConversationStats;

/// `Math.round`: the nearest integer, halves toward positive infinity.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Mean time a verdict took, in whole milliseconds.
///
/// This is the number that says whether the gate is keeping the room waiting: it sits
/// between somebody finishing a sentence and the agent starting to answer.
///
/// Zero when nothing was judged, rather than absent — a call where nobody spoke to the
/// agent is a common outcome, and a missing property looks the same as a build that never
/// emitted it.
pub fn mean_gate_latency_ms(stats: Option<&VoiceConversationStats>) -> i64 {
    let calls = stats.map(|s| s.gate_calls).unwrap_or(0);
    if calls == 0 {
        return 0;
    }
    let latency = stats.map(|s| s.gate_latency_ms).unwrap_or(0);
    js_round(latency as f64 / calls as f64) as i64
}
