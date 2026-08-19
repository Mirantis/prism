/**
 * The gate that decides whether an utterance in the room becomes speech.
 *
 * Everything here is about false positives: a "yes" from this object always
 * reaches the room, because once `response.create` goes out the model has no way
 * to decline. So the tests that matter most are the ones asserting silence.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { ResponsePolicy } from '../response-policy';
import { warmVocativeTagger } from '../vocative';

/**
 * A policy with the follow-up window **off** unless a test asks for it.
 *
 * Deliberate: every case below is about the two original reasons to answer, and a window
 * left on would give some of them a third way to say yes. The window has its own block at
 * the end of this file, and its own unit tests in `follow-up-window.test.ts`.
 */
const policy = (over: Partial<ConstructorParameters<typeof ResponsePolicy>[0]> = {}) =>
  new ResponsePolicy({
    mode: 'auto',
    agentName: 'Prism',
    followUpWindowMs: 0,
    ...over,
  });

/**
 * One utterance through both paths.
 *
 * `'classify'` means this object declined to decide — the window did not cover it,
 * so whether the agent was named is a question for the model. The decision then
 * continues in `resolveClassification`.
 */
const utterance = (p: ResponsePolicy, itemId: string): boolean | 'classify' => {
  if (p.onUtteranceCommitted(itemId)) return true;
  const decision = p.onTranscript(itemId);
  return decision === 'classify' ? 'classify' : decision === 'respond';
};

beforeAll(async () => {
  // The follow-up window's drift tests read POS tags synchronously, and until the tagger is
  // loaded they have no verdict — so the window declines everything, which is the safe
  // direction but not what the cases below are about. `VoiceConversation.start()` does this
  // when a call opens. Warmed before `useFakeTimers`, since it is a module load.
  await warmVocativeTagger();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('choosing a mode from the room', () => {
  it('answers everything when there is one other person', () => {
    const p = policy();
    p.setParticipantCount(2);

    expect(p.effectiveMode).toBe('open');
    // No transcript needed, and none waited for: this fires at the turn boundary,
    // which is exactly where the server would have created the response itself.
    expect(p.onUtteranceCommitted('i1')).toBe(true);
  });

  it('defers to the classifier once a third person joins', () => {
    const p = policy();
    p.setParticipantCount(2);
    p.setParticipantCount(3);

    expect(p.effectiveMode).toBe('addressed');
    expect(utterance(p, 'i1')).toBe('classify');
  });

  it('assumes a crowd until it has been told otherwise', () => {
    // Guessing "open" before the first reading would put the agent straight back
    // to answering a whole room; guessing "addressed" costs one spoken name.
    expect(policy().effectiveMode).toBe('addressed');
  });

  it('keeps the current mode when the count cannot be read', () => {
    const p = policy();
    p.setParticipantCount(2);
    p.setParticipantCount(null);

    expect(p.effectiveMode).toBe('open');
    expect(p.statistics.modeSwitches).toBe(1);
  });

  it('ignores the room when a mode was asked for explicitly', () => {
    const p = policy({ mode: 'addressed' });
    p.setParticipantCount(2);

    expect(p.effectiveMode).toBe('addressed');
  });

  it('counts a switch only when the mode actually changes', () => {
    const p = policy();
    p.setParticipantCount(5);
    p.setParticipantCount(6);

    expect(p.statistics.modeSwitches).toBe(0);
  });
});

/**
 * A call the room cannot hear the agent in.
 *
 * `open` mode answers every utterance at its turn boundary, which is the right call
 * for one human talking to the agent and an expensive way to say nothing when the
 * microphone is not live: a full Realtime response per sentence, for an hour, none of
 * it heard. `addressed` is bounded by somebody choosing to say the agent's name, and
 * staying responsive there is deliberate — an agent that cannot be heard can still
 * *act* on what it is asked, and the action lands even when the confirmation doesn't.
 */
describe('an agent nobody can hear', () => {
  it('stops answering everything said in the room', () => {
    const p = policy();
    p.setParticipantCount(2);
    expect(p.effectiveMode).toBe('open');

    p.setAudible(false);

    expect(p.effectiveMode).toBe('addressed');
    expect(p.onUtteranceCommitted('i1')).toBe(false);
  });

  it('does not drift back into open mode on the next count reading', () => {
    // The count keeps arriving every ten seconds while this is true, and each one is a
    // fresh chance to undo the decision.
    const p = policy();
    p.setAudible(false);
    p.setParticipantCount(2);

    expect(p.effectiveMode).toBe('addressed');
  });

  it('goes back to open mode once the room can hear it again', () => {
    // The retry succeeds mid-call, so this is a real transition rather than a
    // theoretical one.
    const p = policy();
    p.setParticipantCount(2);
    p.setAudible(false);
    p.setAudible(true);
    p.setParticipantCount(2);

    expect(p.effectiveMode).toBe('open');
  });

  it('restores a mode that was asked for explicitly, which no count would bring back', () => {
    // `setParticipantCount` is inert for an explicit mode, so recovery cannot be left
    // to the poll the way it is for `auto`.
    const p = policy({ mode: 'open' });
    p.setAudible(false);
    expect(p.effectiveMode).toBe('addressed');

    p.setAudible(true);

    expect(p.effectiveMode).toBe('open');
  });

  it('still answers when it is addressed by name', () => {
    // Not a lobotomy: the agent is inaudible, not absent, and the tools still work.
    const p = policy();
    p.setParticipantCount(4);
    p.setAudible(false);

    expect(utterance(p, 'i1')).toBe('classify');
  });
});

describe('being addressed', () => {
  const crowded = () => {
    const p = policy();
    p.setParticipantCount(4);
    return p;
  };

  it('answers when the model says the agent was named', () => {
    const p = crowded();
    expect(utterance(p, 'i1')).toBe('classify');
    expect(p.resolveClassification('i1', true)).toBe(true);
    expect(p.statistics.addressedMatches).toBe(1);
  });

  it('stays quiet when the model says it was not for the agent', () => {
    const p = crowded();

    expect(utterance(p, 'i1')).toBe('classify');
    expect(p.resolveClassification('i1', false)).toBe(false);
    expect(p.statistics.suppressed).toBe(1);
    expect(p.statistics.answered).toBe(0);
  });

  it('answers an utterance once, not once per path', () => {
    // Both the commit and the transcript path see every utterance. A double yes
    // would not be dropped by the session — it defers and then replays it — so
    // the room would hear the same answer twice.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('i1')).toBe(true);
    expect(p.onTranscript('i1')).toBe('ignore');
    expect(p.statistics.answered).toBe(1);
  });

  it('drops a verdict for an utterance already answered', () => {
    // Two verdicts can be in flight for one utterance — one judged from a partial
    // transcript, one from the finished text. Answering both would not be
    // deduplicated by the session; it queues the second, so the room hears the
    // same reply twice.
    const p = crowded();

    expect(p.resolveClassification('i1', true)).toBe(true);
    expect(p.resolveClassification('i1', true)).toBe(false);
    expect(p.statistics.answered).toBe(1);
  });

  it('needs the name every time, with no grace period after it speaks', () => {
    // A 15s window used to make any utterance count as addressed after the agent
    // spoke. On real calls that window was mostly other people starting to talk to
    // each other — the exact failure this gate exists to prevent.
    const p = crowded();

    expect(p.resolveClassification('i1', true)).toBe(true);
    expect(p.onUtteranceCommitted('i2')).toBe(false);
    expect(p.onTranscript('i2')).toBe('classify');
  });
});

describe('degraded inputs', () => {
  it('still ignores an id-less transcript when the room filled mid-utterance', () => {
    // Open mode answered it at the boundary; a participant joining before the words
    // arrive must not unlatch the guard and let the same sentence be answered twice.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('')).toBe(true);
    p.setParticipantCount(4);

    expect(p.onTranscript('')).toBe('ignore');
  });

  it('ignores an id-less transcript in open mode, rather than risk a double', () => {
    // Open mode answered at the boundary, and with no id there is nothing to
    // recognise that by here. A second request for one utterance is queued rather
    // than dropped, so the room would hear the same reply twice.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('')).toBe(true);
    expect(p.onTranscript('')).toBe('ignore');
  });

  it('still judges an id-less transcript when nothing answered it', () => {
    const p = policy();
    p.setParticipantCount(4);

    expect(p.onUtteranceCommitted('')).toBe(false);
    expect(p.onTranscript('')).toBe('classify');
  });
});

describe('counting what happened', () => {
  it('counts one suppression per utterance, not one per verdict', () => {
    // An utterance is judged twice — once while the speaker is still talking, once
    // on the finished sentence — and both verdicts land here. Counting each "no"
    // would report roughly double, and `suppressed` against `utterances` is exactly
    // the ratio that says whether the gate earned its keep.
    const p = policy({ mode: 'addressed' });

    expect(p.resolveClassification('i1', false, 'partial')).toBe(false);
    expect(p.resolveClassification('i1', false, 'final')).toBe(false);

    expect(p.statistics.suppressed).toBe(1);
  });

  it('counts an answer once however many verdicts arrive', () => {
    const p = policy({ mode: 'addressed' });

    expect(p.resolveClassification('i1', true, 'partial')).toBe(true);
    expect(p.resolveClassification('i1', true, 'final')).toBe(false);

    expect(p.statistics.answered).toBe(1);
    expect(p.statistics.addressedMatches).toBe(1);
  });
});

describe('a mode flip mid-utterance', () => {
  it('still answers someone who used the name as the room emptied', () => {
    // The count is polled, so it can land in the second between an utterance
    // closing and its words arriving.
    const p = policy();
    p.setParticipantCount(4);

    expect(p.onUtteranceCommitted('i1')).toBe(false);
    p.setParticipantCount(2);

    expect(p.onTranscript('i1')).toBe('classify');
    expect(p.resolveClassification('i1', true)).toBe(true);
  });

  it('does not answer twice when the room filled instead', () => {
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('i1')).toBe(true);
    p.setParticipantCount(4);

    expect(p.onTranscript('i1')).toBe('ignore');
  });
});

describe('not paying for a verdict that cannot matter', () => {
  it('skips the early look in open mode', () => {
    // One human in the room: the utterance is answered at its turn boundary
    // whatever the gate would say. Judging it anyway bought nothing and cost a
    // model call per sentence — on a live one-to-one call a verdict arrived 1.5s
    // after the agent had already begun answering that same utterance.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onTranscript('item-1', 'partial')).toBe('ignore');
  });

  it('still judges the finished transcript in open mode', () => {
    // The mode can flip between an utterance closing and its words arriving, so
    // the authoritative pass is not skipped — only the speculative one.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onTranscript('item-1', 'final')).toBe('classify');
  });

  it('keeps the early look when the agent must be named', () => {
    const p = policy({ mode: 'addressed' });

    expect(p.onTranscript('item-1', 'partial')).toBe('classify');
  });

  it('never re-judges an utterance already answered', () => {
    const p = policy();
    p.setParticipantCount(2);
    p.onUtteranceCommitted('item-1');

    expect(p.onTranscript('item-1', 'final')).toBe('ignore');
  });
});

describe('staying in an exchange without being named again', () => {
  /** A policy that has just answered Mario and finished speaking. */
  const inExchange = () => {
    const p = policy({ mode: 'addressed', followUpWindowMs: 8_000 });
    p.setCurrentSpeaker('Mario');
    expect(p.resolveClassification('i1', true)).toBe(true);
    p.onAgentTurnEnded();
    return p;
  };

  it('starts the clock at the partial, so a long question is not penalised for its length', () => {
    // Half of the wiring: that the policy hands a partial's words to the window and that the
    // clock then reads from them. The other half — that the *conversation* passes those words
    // at all — cannot be seen from here, and that is exactly where two live failures came
    // from. `voice-conversation.test.ts` covers it by driving the conversation instead.
    const p = inExchange();

    vi.advanceTimersByTime(2_000);
    expect(p.onTranscript('i2', 'partial', 'so on that deploy, I was wondering whether')).toBe(
      'classify',
    );

    // Nine more seconds of talking — past the window, if the clock were read at the end.
    vi.advanceTimersByTime(9_000);
    expect(p.onTranscript('i2', 'final', 'can you check whether staging picked it up?')).toBe(
      'respond',
    );
  });

  it('answers a follow-up carrying no name, without a model call', () => {
    const p = inExchange();

    // `respond` rather than `classify` is where the 0ms comes from: the gate is skipped
    // outright rather than raced.
    expect(p.onTranscript('i2', 'final', 'and can you check staging as well?')).toBe('respond');
    expect(p.statistics.followUp.accepted).toBe(1);
  });

  it('marks the utterance answered so the other path cannot answer it twice', () => {
    const p = inExchange();
    p.onTranscript('i2', 'final', 'and can you check staging?');

    // A second `response.create` is queued by the session rather than dropped, so the room
    // would hear the same reply twice.
    expect(p.resolveClassification('i2', true)).toBe(false);
    expect(p.onTranscript('i2', 'final', 'and can you check staging?')).toBe('ignore');
  });

  it('still asks the model about anything the window declines', () => {
    const p = inExchange();

    // The window can only ever *add* an answer. Everything it turns down has to reach the
    // gate, or the feature would be silencing utterances rather than speeding them up.
    expect(p.onTranscript('i2', 'final', 'Tom, do you know the port?')).toBe('classify');
  });

  it('does nothing without a transcript to read', () => {
    const p = inExchange();

    // `open` mode answers at the turn boundary with no words at all, and a caller that has
    // none cannot be offered a decision that depends on them.
    expect(p.onTranscript('i2', 'final')).toBe('classify');
  });

  it('still opens when the platform could not say who spoke', () => {
    const p = policy({ mode: 'addressed', followUpWindowMs: 8_000 });
    p.setCurrentSpeaker(null);
    p.resolveClassification('i1', true);
    p.onAgentTurnEnded();

    // This used to be inert without attribution, because a follow-up had to come from the same
    // person and there was nobody to compare against. Eligibility is now about what was said,
    // so a call whose participants panel cannot be read keeps the behaviour rather than
    // silently losing it — and the drift guards are what keep that safe.
    expect(p.onTranscript('i2', 'final', 'and can you check staging?')).toBe('respond');
  });

  it('is off entirely when the operator sets the window to zero', () => {
    const p = policy({ mode: 'addressed', followUpWindowMs: 0 });
    p.setCurrentSpeaker('Mario');
    p.resolveClassification('i1', true);
    p.onAgentTurnEnded();

    expect(p.onTranscript('i2', 'final', 'and can you check staging?')).toBe('classify');
  });
});
