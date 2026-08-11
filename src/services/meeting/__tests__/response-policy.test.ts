/**
 * The gate that decides whether an utterance in the room becomes speech.
 *
 * Everything here is about false positives: a "yes" from this object always
 * reaches the room, because once `response.create` goes out the model has no way
 * to decline. So the tests that matter most are the ones asserting silence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponsePolicy, STICKY_WINDOW_MS, MAX_STICKY_TURNS } from '../response-policy';

const policy = (over: Partial<ConstructorParameters<typeof ResponsePolicy>[0]> = {}) =>
  new ResponsePolicy({ mode: 'auto', agentName: 'Prism', ...over });

/** One utterance, from turn-end through to its transcript landing. */
const utterance = (p: ResponsePolicy, itemId: string, transcript: string): boolean => {
  const atCommit = p.onUtteranceCommitted(itemId);
  const atTranscript = p.onTranscript(itemId, transcript);
  return atCommit || atTranscript;
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

  it('waits to be addressed once a third person joins', () => {
    const p = policy();
    p.setParticipantCount(2);
    p.setParticipantCount(3);

    expect(p.effectiveMode).toBe('addressed');
    expect(utterance(p, 'i1', 'so I told Dana we would ship on Friday')).toBe(false);
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

  it('answers when its name comes up', () => {
    const p = crowded();
    expect(utterance(p, 'i1', 'Prism, can you check the cluster?')).toBe(true);
    expect(p.statistics.addressedMatches).toBe(1);
  });

  it('answers to an alias, for a name transcription mangles', () => {
    const p = policy({ mode: 'addressed', aliases: ['prisma'] });
    expect(utterance(p, 'i1', 'prisma, check the cluster')).toBe(true);
  });

  it('stays quiet through people talking to each other', () => {
    const p = crowded();
    expect(utterance(p, 'i1', 'did you see the Friday numbers')).toBe(false);
    expect(utterance(p, 'i2', 'yeah, they were fine')).toBe(false);
    expect(p.statistics.suppressed).toBe(2);
    expect(p.statistics.answered).toBe(0);
  });

  it('answers an utterance once, not once per path', () => {
    // Both the commit and the transcript path see every utterance. A double yes
    // would not be dropped by the session — it defers and then replays it — so
    // the room would hear the same answer twice.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('i1')).toBe(true);
    expect(p.onTranscript('i1', 'Prism, hello')).toBe(false);
    expect(p.statistics.answered).toBe(1);
  });
});

describe('the follow-up window', () => {
  const engaged = () => {
    const p = policy();
    p.setParticipantCount(4);
    p.onAgentTurnEnded();
    return p;
  };

  it('takes the next utterance without needing the name again', () => {
    const p = engaged();
    // "and what about staging?" — a continuation, not a fresh request.
    expect(p.onUtteranceCommitted('i1')).toBe(true);
  });

  it('lapses, so a room that moves on is not interrupted', () => {
    const p = engaged();
    vi.advanceTimersByTime(STICKY_WINDOW_MS + 1);

    expect(utterance(p, 'i1', 'anyway, about the roadmap')).toBe(false);
  });

  it('stops coasting after a few unnamed turns', () => {
    const p = engaged();

    for (let i = 0; i < MAX_STICKY_TURNS; i += 1) {
      expect(p.onUtteranceCommitted(`i${i}`)).toBe(true);
      // Each answer re-opens the window, which is how a conversation would run
      // away with itself if the budget below were not there.
      p.onAgentTurnEnded();
    }

    expect(utterance(p, 'last', 'and then Dana said no')).toBe(false);
  });

  it('refills the budget when someone says the name again', () => {
    const p = engaged();
    for (let i = 0; i < MAX_STICKY_TURNS; i += 1) {
      p.onUtteranceCommitted(`i${i}`);
      p.onAgentTurnEnded();
    }

    expect(utterance(p, 'named', 'Prism, one more thing')).toBe(true);
    p.onAgentTurnEnded();
    expect(p.onUtteranceCommitted('after')).toBe(true);
  });

  it('refills the budget on a mention even when the window already answered', () => {
    // The window answers at the turn boundary, before the words exist. Reading them
    // afterwards is what keeps a fully named back-and-forth from running out of
    // turns and stalling on transcript latency at the fourth question.
    const p = engaged();
    for (let i = 0; i < MAX_STICKY_TURNS; i += 1) {
      expect(p.onUtteranceCommitted(`i${i}`)).toBe(true);
      expect(p.onTranscript(`i${i}`, 'Prism, and staging?')).toBe(false);
      p.onAgentTurnEnded();
    }

    expect(p.onUtteranceCommitted('fourth')).toBe(true);
  });

  it('opens the window on an interruption without refilling the budget', () => {
    // Barge-in fires on any human speech overlapping the agent for half a second,
    // which in a busy room is just two people carrying on while it talks. If that
    // refilled the budget, cross-talk would renew its own licence forever and the
    // agent would be back to answering the whole room.
    const p = engaged();
    for (let i = 0; i < MAX_STICKY_TURNS; i += 1) {
      p.onUtteranceCommitted(`i${i}`);
      p.onAgentTurnEnded();
    }

    p.onInterrupted();
    expect(utterance(p, 'cross-talk', 'no, Dana said Thursday')).toBe(false);
  });

  it('answers an interruption that arrives with the budget intact', () => {
    const p = policy();
    p.setParticipantCount(4);
    p.onInterrupted();

    // Someone cutting the agent off is usually reacting to it, and shouldn't have
    // to say its name to be heard.
    expect(p.onUtteranceCommitted('i1')).toBe(true);
  });
});

describe('degraded inputs', () => {
  it('answers a named utterance whose mode flipped mid-flight', () => {
    // The count is polled, so it can land between an utterance closing and its
    // transcript arriving. Someone who said the name must not get silence for it.
    const p = policy();
    p.setParticipantCount(4);

    expect(p.onUtteranceCommitted('i1')).toBe(false);
    p.setParticipantCount(2);

    expect(p.onTranscript('i1', 'Prism, are we good?')).toBe(true);
  });

  it('leaves an utterance with no id to the transcript, rather than risk a double', () => {
    // Nothing ties the two paths together without an id, and a second request for
    // one utterance is queued rather than dropped — the room would hear it twice.
    const p = policy();
    p.setParticipantCount(4);
    p.onAgentTurnEnded();

    expect(p.onUtteranceCommitted('')).toBe(false);
    expect(p.onTranscript('', 'Prism, one thing')).toBe(true);
  });
});
