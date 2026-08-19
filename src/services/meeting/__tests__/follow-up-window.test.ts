/**
 * Staying in an exchange without being named again — the timing half of it.
 *
 * The predecessor of this feature, a flat 15-second grace period with no idea who was
 * talking, was removed after live testing because it answered people talking to each other.
 * The version after that tried to tell those apart with hand-written sentence rules; those
 * are gone too, and `follow-up-judge.test.ts` covers what replaced them. What is left here is
 * a clock, and every case below is about when an utterance is allowed to be judged at all.
 *
 * The asymmetry the cases are shaped around has not changed: an utterance this declines falls
 * through to the addressed gate and is answered ~1.3s later, while one it wrongly allows is
 * only ever *offered* to the judge. So the expensive mistakes live in the judge, and the
 * expensive mistake here is declining a real follow-up — which is why so many of these are
 * about a sentence that began in time and finished late.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FollowUpWindow } from '../follow-up-window';

import { logger } from '../../../logger';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const window = (over: Partial<ConstructorParameters<typeof FollowUpWindow>[0]> = {}) =>
  new FollowUpWindow({ windowMs: 8_000, agentName: 'Iris', ...over });

/** Armed and ready: the agent answered Mario and has finished speaking. */
const armed = (over?: Partial<ConstructorParameters<typeof FollowUpWindow>[0]>) => {
  const w = window(over);
  w.arm('Mario');
  w.onAgentTurnEnded();
  return w;
};

beforeEach(() => {
  // Per test, so a log assertion is about the case that made it rather than about anything an
  // earlier one happened to emit.
  vi.mocked(logger.info).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Every `info` line emitted so far, joined — the close reasons live here. */
function infoLines(): string {
  return vi
    .mocked(logger.info)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
}

/** A fresh utterance id per call; the window keys its clock on these. */
let items = 0;
const item = () => `item-${++items}`;

describe('opening a window', () => {
  it('offers a finished utterance once the agent has answered somebody', () => {
    const w = armed();

    expect(w.eligible('final', item())).toBe(true);
  });

  it('stays shut until the agent has actually answered somebody', () => {
    const w = window();

    // Nothing armed it, so there is no exchange to continue.
    expect(w.eligible('final', item())).toBe(false);
    expect(w.isOpen).toBe(false);
  });

  it('opens even when the platform cannot say who spoke', () => {
    // This used to be inert without attribution, because a follow-up had to come from the
    // same person and there was no way to check. Anybody may continue an exchange now, so a
    // call whose participants panel cannot be read keeps the behaviour instead of losing it —
    // the judge reads speaker labels where they exist and the words alone where they do not.
    const w = window();
    w.arm(null);
    w.onAgentTurnEnded();

    expect(w.isOpen).toBe(true);
    expect(w.eligible('final', item())).toBe(true);
  });

  it('is inert when the operator has turned it off', () => {
    const w = armed({ windowMs: 0 });

    expect(w.isOpen).toBe(false);
    expect(w.eligible('final', item())).toBe(false);
  });

  it('measures from the agent’s turn ending, not from the request', () => {
    const w = window();
    w.arm('Mario');
    // Five seconds of the agent talking. What Mario follows up on is the answer, so the
    // clock cannot start when he asked.
    vi.advanceTimersByTime(5_000);
    w.onAgentTurnEnded();
    vi.advanceTimersByTime(7_000);

    expect(w.eligible('final', item())).toBe(true);
  });

  it('allows a follow-up that began inside the window but took a while to say', () => {
    const w = armed();
    const sentence = item();

    // Measured on a live call: the speaker began 2.3s after the agent stopped — plainly a
    // follow-up — spent about seven seconds asking their question, and was declined because
    // the eight seconds ran out while they were still talking. The clock asks *when they
    // started*, which is what the partial is for; whether the words are for the agent is a
    // separate question, asked of the finished sentence. Judging both at the end conflated
    // the two and penalised a follow-up for being long.
    vi.advanceTimersByTime(2_300);
    expect(w.eligible('partial', sentence)).toBe(false);

    vi.advanceTimersByTime(6_900); // 9.2s after the turn — past the window
    expect(w.eligible('final', sentence)).toBe(true);
  });

  it('allows a follow-up that began while the agent was still speaking', () => {
    const w = window();
    w.arm('Mario');
    const sentence = item();

    // The live sequence, measured off a real call. The agent answered, Mario began his
    // follow-up 7.2s in — while it was still talking, which is how people actually follow
    // up — and finished 8.4s after it stopped.
    vi.advanceTimersByTime(7_200);
    expect(w.eligible('partial', sentence)).toBe(false);

    // Audio still reaching the room. This fires per chunk, and clearing the clocks here wiped
    // the stamp of the sentence already under way.
    w.onAgentTurnStarted();
    vi.advanceTimersByTime(1_000);
    w.onAgentTurnStarted();

    vi.advanceTimersByTime(2_800);
    w.onAgentTurnEnded();

    vi.advanceTimersByTime(8_400); // past the window, measured from the turn ending
    expect(w.eligible('final', sentence)).toBe(true);
    expect(w.statistics.lapsed).toBe(0);
  });

  it('says how late the next thing said actually was', () => {
    // The clock is evaluated when somebody speaks, not on a timer, so this line can appear
    // long after the exchange lapsed — eighty seconds later, in one live log, which read as
    // though the window had been open all that time.
    const w = armed();
    vi.advanceTimersByTime(85_000);

    w.eligible('final', item());
    expect(infoLines()).toContain('came 85.0s after my turn');
  });

  it('closes when the next thing said only begins after the window', () => {
    const w = armed();
    vi.advanceTimersByTime(9_000);

    expect(w.eligible('final', item())).toBe(false);
    expect(w.statistics.lapsed).toBe(1);
    expect(w.isOpen).toBe(false);
  });

  it('re-opens when the agent is addressed again', () => {
    const w = armed();
    vi.advanceTimersByTime(9_000);
    w.eligible('final', item());
    expect(w.isOpen).toBe(false);

    w.arm('Mario');
    w.onAgentTurnEnded();

    expect(w.eligible('final', item())).toBe(true);
  });
});

describe('what the judge decides', () => {
  it('counts and reports an answer', () => {
    const w = armed();
    vi.advanceTimersByTime(1_500);
    w.eligible('final', item());

    w.accept();

    expect(w.statistics.accepted).toBe(1);
    expect(infoLines()).toContain('started 1500ms after my turn');
  });

  it('reports a follow-up that began before the answer had finished', () => {
    const w = window();
    w.arm('Mario');
    const sentence = item();
    w.eligible('partial', sentence); // stamped while the agent was still talking

    vi.advanceTimersByTime(2_000);
    w.onAgentTurnEnded();
    w.eligible('final', sentence);
    w.accept();

    expect(infoLines()).toContain('started 2000ms before my turn ended');
  });

  it('keeps the exchange open when the judge turns an utterance down', () => {
    // The change that made the judge possible. A rule reading one sentence had to close on a
    // decline, because it could not tell "the exchange is over" from "that particular
    // sentence wanted nothing" — so one "yeah" ended an exchange. The judge reads the
    // utterance against the transcript, so the next one is judged on its own merits.
    const w = armed();

    expect(w.eligible('final', item())).toBe(true);
    w.decline();
    expect(w.isOpen).toBe(true);

    expect(w.eligible('final', item())).toBe(true);
    w.decline();
    expect(w.isOpen).toBe(true);

    expect(w.eligible('final', item())).toBe(true);
    w.accept();

    expect(w.statistics).toEqual({ accepted: 1, declined: 2, lapsed: 0 });
  });
});

describe('a transcript that is still being written', () => {
  it('does not offer a partial, however much of a follow-up it looks like', () => {
    const w = armed();

    // Acting early sounds harmless and is not. The words that say who a sentence was *for*
    // can arrive last: "And what do you think" reads as a follow-up and belongs to
    // "...about the rollout, Pamela?".
    expect(w.eligible('partial', item())).toBe(false);
    expect(w.isOpen).toBe(true);
  });

  it('never closes on a partial either', () => {
    const w = armed();

    // The live failure this prevents, verbatim from a call:
    //   partial "Now, we want to talk about, about, you know..."  → reads as a statement
    //   final   "...can you put together an agenda for that?"     → obviously a follow-up
    // Closing on the partial meant the finished request arrived to a shut window and the
    // speaker had to say the agent's name again.
    const sentence = item();
    expect(w.eligible('partial', sentence)).toBe(false);
    expect(w.isOpen).toBe(true);

    expect(w.eligible('final', sentence)).toBe(true);
  });
});

describe('while the agent is the one talking', () => {
  it('does not start the clock until the turn it belongs to has ended', () => {
    const w = window();
    w.arm('Mario');

    // Between arming and the agent finishing there is no window yet, and — crucially —
    // nothing said in that gap may *close* one. A previous version kept the last exchange's
    // timestamp through `arm()`, so a backchannel during a ten-second answer was measured
    // against an expired clock, fired a close, and killed the follow-ups of an exchange that
    // had not started.
    expect(w.eligible('final', item())).toBe(false);
    expect(w.statistics.lapsed).toBe(0);

    w.onAgentTurnEnded();

    expect(w.eligible('final', item())).toBe(true);
  });

  it('suspends a live window for the length of the next answer', () => {
    const w = armed();
    // A chained exchange: the follow-up is answered, so the agent speaks again.
    expect(w.eligible('final', item())).toBe(true);
    w.accept();
    w.onAgentTurnStarted();

    // "yeah, got it" while that answer is still playing is a reaction to it, not the
    // exchange ending. Without this it was measured against the *previous* turn's clock,
    // which had expired, and closed the window before the answer it reacted to had finished.
    expect(w.eligible('final', item())).toBe(false);
    expect(w.isOpen).toBe(false);
    expect(w.statistics.lapsed).toBe(0);

    w.onAgentTurnEnded();

    expect(w.eligible('final', item())).toBe(true);
  });
});
