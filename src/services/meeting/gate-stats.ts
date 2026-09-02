/**
 * Numbers derived from a voice session's gate counters.
 *
 * Its own module because both session owners emit these under the same telemetry keys,
 * and both mock `voice-conversation` in their tests — a derivation living there would be
 * mocked away and each owner would grow its own copy. A sum in one event and a mean in
 * the other are incomparable while looking like one metric.
 *
 * The stats type is imported for its shape only, so nothing here depends on the session.
 */

import type { VoiceConversationStats } from './voice-conversation';

/**
 * Mean time a verdict took, in whole milliseconds.
 *
 * This is the number that says whether the gate is keeping the room waiting: it sits
 * between somebody finishing a sentence and the agent starting to answer.
 *
 * Zero when nothing was judged, rather than absent — a call where nobody spoke to the
 * agent is a common outcome, and a missing property looks the same as a build that never
 * emitted it.
 */
export function meanGateLatencyMs(stats: VoiceConversationStats | undefined): number {
  const calls = stats?.gateCalls ?? 0;
  if (calls === 0) return 0;
  return Math.round((stats?.gateLatencyMs ?? 0) / calls);
}
