/**
 * The gate that decides whether an utterance in the room becomes speech.
 *
 * Everything here is about false positives: a "yes" from this object always
 * reaches the room, because once `response.create` goes out the model has no way
 * to decline. So the tests that matter most are the ones asserting silence.
 *
 * A whole class of test that used to live here is gone, and its absence is the
 * point. An utterance used to be seen twice — once when the turn detector closed
 * it, once when its words arrived — so half of these cases existed to stop one
 * sentence being answered by both paths. The audio gate is asked at the turn
 * boundary and nowhere else, so one utterance produces one decision and one
 * verdict, and there is no second path left to collide with.
 */

import { describe, it, expect } from 'vitest';
import { ResponsePolicy } from '../response-policy';

const policy = (over: Partial<ConstructorParameters<typeof ResponsePolicy>[0]> = {}) =>
  new ResponsePolicy({ mode: 'auto', ...over });

describe('choosing a mode from the room', () => {
  it('answers everything when there is one other person', () => {
    const p = policy();
    p.setParticipantCount(2);

    expect(p.effectiveMode).toBe('open');
    // No transcript needed, and none waited for: this fires at the turn boundary,
    // which is exactly where the server would have created the response itself.
    expect(p.onUtteranceCommitted('i1')).toBe('respond');
  });

  it('asks the gate once a third person joins', () => {
    const p = policy();
    p.setParticipantCount(2);
    p.setParticipantCount(3);

    expect(p.effectiveMode).toBe('addressed');
    expect(p.onUtteranceCommitted('i1')).toBe('gate');
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
    expect(p.onUtteranceCommitted('i1')).toBe('gate');
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

    expect(p.onUtteranceCommitted('i1')).toBe('gate');
  });
});

describe('being addressed', () => {
  const crowded = () => {
    const p = policy();
    p.setParticipantCount(4);
    return p;
  };

  it('answers when the model says the utterance was for the agent', () => {
    const p = crowded();
    expect(p.onUtteranceCommitted('i1')).toBe('gate');
    expect(p.resolveVerdict('i1', true)).toBe(true);
    expect(p.statistics.addressedMatches).toBe(1);
  });

  it('stays quiet when the model says it was not', () => {
    const p = crowded();

    expect(p.onUtteranceCommitted('i1')).toBe('gate');
    expect(p.resolveVerdict('i1', false)).toBe(false);
    expect(p.statistics.suppressed).toBe(1);
    expect(p.statistics.answered).toBe(0);
  });

  it('drops a second verdict for an utterance already answered', () => {
    // A retried probe, or a late duplicate from the server. Answering both would
    // not be deduplicated by the session — it queues the second — so the room
    // would hear the same reply twice.
    const p = crowded();

    expect(p.resolveVerdict('i1', true)).toBe(true);
    expect(p.resolveVerdict('i1', true)).toBe(false);
    expect(p.statistics.answered).toBe(1);
  });

  it('ignores an utterance the boundary already answered', () => {
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('i1')).toBe('respond');
    // Same id arriving again — a duplicated commit — must not answer twice.
    expect(p.onUtteranceCommitted('i1')).toBe('ignore');
    expect(p.statistics.answered).toBe(1);
  });

  it('does not spend a second probe on a duplicated commit', () => {
    // The first decision claims the utterance before any verdict exists. Waiting
    // for a yes to remember it meant a duplicate commit arriving mid-flight sent a
    // second probe for a question already being judged.
    const p = crowded();

    expect(p.onUtteranceCommitted('i1')).toBe('gate');
    expect(p.onUtteranceCommitted('i1')).toBe('ignore');
    expect(p.statistics.utterances).toBe(1);
  });

  it('makes a no terminal, so a later yes cannot answer it', () => {
    const p = crowded();
    p.onUtteranceCommitted('i1');

    expect(p.resolveVerdict('i1', false)).toBe(false);
    // A retried probe, or a duplicate from the server. The first verdict decided.
    expect(p.resolveVerdict('i1', true)).toBe(false);
    expect(p.statistics.answered).toBe(0);
    expect(p.statistics.suppressed).toBe(1);
  });

  it('counts one suppression per utterance, not one per verdict', () => {
    const p = crowded();
    p.onUtteranceCommitted('i1');

    p.resolveVerdict('i1', false);
    p.resolveVerdict('i1', false);

    // `suppressed` against `utterances` is the ratio the stats exist for; double
    // counting either side quietly makes it meaningless.
    expect(p.statistics.suppressed).toBe(1);
    expect(p.statistics.utterances).toBe(1);
  });

  it('needs the name every time, with no grace period after it speaks', () => {
    // A 15s window used to make any utterance count as addressed after the agent
    // spoke. On real calls that window was mostly other people starting to talk to
    // each other — the exact failure this gate exists to prevent.
    const p = crowded();

    expect(p.resolveVerdict('i1', true)).toBe(true);
    expect(p.onUtteranceCommitted('i2')).toBe('gate');
  });
});

describe('degraded inputs', () => {
  it('answers an id-less utterance in open mode', () => {
    // Nothing to remember it by, but nothing needs to: one utterance is decided
    // once now, so there is no second path that could answer it again.
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('')).toBe('respond');
  });

  it('still puts an id-less utterance to the gate in a crowd', () => {
    const p = policy();
    p.setParticipantCount(4);

    // The gate refuses it for want of something to point at — see
    // `addressed-audio-gate.ts` — but that is the gate's judgement, not this
    // object's, and the mode decision is unaffected.
    expect(p.onUtteranceCommitted('')).toBe('gate');
  });
});

describe('counting what happened', () => {
  it('counts every utterance the room produced, answered or not', () => {
    const p = policy({ mode: 'addressed' });

    p.onUtteranceCommitted('i1');
    p.onUtteranceCommitted('i2');
    p.resolveVerdict('i1', true);
    p.resolveVerdict('i2', false);

    expect(p.statistics.utterances).toBe(2);
    expect(p.statistics.answered).toBe(1);
    expect(p.statistics.suppressed).toBe(1);
  });

  it('counts an answer once however many verdicts arrive', () => {
    const p = policy({ mode: 'addressed' });

    expect(p.resolveVerdict('i1', true)).toBe(true);
    expect(p.resolveVerdict('i1', true)).toBe(false);

    expect(p.statistics.answered).toBe(1);
    expect(p.statistics.addressedMatches).toBe(1);
  });
});

describe('a mode flip while a verdict is in flight', () => {
  it('still answers someone who used the name as the room emptied', () => {
    // The count is polled, so it can land in the second between an utterance
    // closing and its verdict arriving. The question was already asked; the
    // answer is still worth acting on.
    const p = policy();
    p.setParticipantCount(4);

    expect(p.onUtteranceCommitted('i1')).toBe('gate');
    p.setParticipantCount(2);

    expect(p.resolveVerdict('i1', true)).toBe(true);
  });

  it('does not answer twice when the room filled instead', () => {
    const p = policy();
    p.setParticipantCount(2);

    expect(p.onUtteranceCommitted('i1')).toBe('respond');
    p.setParticipantCount(4);

    // A verdict for an utterance open mode already spoke to must not add a second.
    expect(p.resolveVerdict('i1', true)).toBe(false);
  });
});
