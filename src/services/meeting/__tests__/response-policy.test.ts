/**
 * The gate that decides whether an utterance in the room becomes speech.
 *
 * Everything here is about false positives: a "yes" from this object always
 * reaches the room, because once `response.create` goes out the model has no way
 * to decline. So the tests that matter most are the ones asserting silence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponsePolicy } from '../response-policy';

const policy = (over: Partial<ConstructorParameters<typeof ResponsePolicy>[0]> = {}) =>
  new ResponsePolicy({ mode: 'auto', ...over });

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
    const policy = new ResponsePolicy({ mode: 'auto' });
    policy.setParticipantCount(2);

    expect(policy.onTranscript('item-1', 'partial')).toBe('ignore');
  });

  it('still judges the finished transcript in open mode', () => {
    // The mode can flip between an utterance closing and its words arriving, so
    // the authoritative pass is not skipped — only the speculative one.
    const policy = new ResponsePolicy({ mode: 'auto' });
    policy.setParticipantCount(2);

    expect(policy.onTranscript('item-1', 'final')).toBe('classify');
  });

  it('keeps the early look when the agent must be named', () => {
    const policy = new ResponsePolicy({ mode: 'addressed' });

    expect(policy.onTranscript('item-1', 'partial')).toBe('classify');
  });

  it('never re-judges an utterance already answered', () => {
    const policy = new ResponsePolicy({ mode: 'auto' });
    policy.setParticipantCount(2);
    policy.onUtteranceCommitted('item-1');

    expect(policy.onTranscript('item-1', 'final')).toBe('ignore');
  });
});
