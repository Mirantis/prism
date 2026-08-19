/**
 * Staying in an exchange without being named again.
 *
 * The predecessor of this feature — a flat 15-second grace period with no idea who was
 * talking — was removed after live testing because it answered people talking to each
 * other. So the cases that matter most here are the ones asserting that an utterance is
 * *not* treated as a follow-up, and nearly all of them are phrasings that were wrongly
 * answered on a real call.
 *
 * What a wrong answer costs, in each direction, is not symmetric and the tests are shaped
 * around that: a declined follow-up falls through to the model gate and is answered ~1.3s
 * later, while an accepted non-follow-up is the agent talking over a human conversation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FollowUpWindow } from '../follow-up-window';
import { warmVocativeTagger } from '../vocative';

import { logger } from '../../../logger';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const window = (over: Partial<ConstructorParameters<typeof FollowUpWindow>[0]> = {}) =>
  new FollowUpWindow({
    windowMs: 8_000,
    otherSpeakerCloses: false,
    otherTurnWords: 6,
    agentName: 'Iris',
    ...over,
  });

/** Armed and ready: the agent answered Mario and has finished speaking. */
const armed = (over?: Partial<ConstructorParameters<typeof FollowUpWindow>[0]>) => {
  const w = window(over);
  w.arm('Mario');
  w.onAgentTurnEnded();
  return w;
};

beforeEach(async () => {
  // Per test, so a log assertion is about the case that made it rather than about anything an
  // earlier one happened to emit.
  vi.mocked(logger.info).mockClear();
  // The drift tests read POS tags synchronously, so the tagger has to be loaded before any
  // of them run — in production `VoiceConversation.start()` does this when a call opens.
  await warmVocativeTagger();
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
  it('answers a follow-up from the same speaker with no name in it', () => {
    const w = armed();

    // The whole point: "can you check the deploy too?" has no name, and repeating the
    // name on every turn is what made the agent tiring to talk to.
    expect(w.consider('and can you check staging as well?', 'final', item())).toBe(true);
    expect(w.statistics.accepted).toBe(1);
  });

  it('stays shut until the agent has actually answered somebody', () => {
    const w = window();

    // Nothing armed it, so there is no exchange to continue.
    expect(w.consider('can you check staging?', 'final', item())).toBe(false);
    expect(w.isOpen).toBe(false);
  });

  it('opens even when the platform cannot say who spoke', () => {
    // This used to be inert without attribution, because a follow-up had to come from the same
    // person and there was no way to check. Eligibility is now about what is said, so a call
    // whose participants panel cannot be read keeps the behaviour instead of losing it.
    const w = window();
    w.arm(null);
    w.onAgentTurnEnded();

    expect(w.isOpen).toBe(true);
    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
  });

  it('is inert when the operator has turned it off', () => {
    const w = armed({ windowMs: 0 });

    expect(w.isOpen).toBe(false);
    expect(w.consider('can you check staging?', 'final', item())).toBe(false);
  });

  it('measures from the agent’s turn ending, not from the request', () => {
    const w = window();
    w.arm('Mario');
    // Five seconds of the agent talking. What Mario follows up on is the answer, so the
    // clock cannot start when he asked.
    vi.advanceTimersByTime(5_000);
    w.onAgentTurnEnded();
    vi.advanceTimersByTime(7_000);

    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
  });

  it('accepts a follow-up that began inside the window but took a while to say', () => {
    const w = armed();
    const sentence = item();

    // Measured on a live call: the speaker began 2.3s after the agent stopped — plainly a
    // follow-up — spent about seven seconds asking their question, and was declined because
    // the eight seconds ran out while they were still talking. The clock asks *when they
    // started*; the drift tests ask *what they said*. Judging both on the finished transcript
    // conflated the two and penalised a follow-up for being long.
    vi.advanceTimersByTime(2_300);
    expect(w.consider('so on that deploy, I was wondering', 'partial', sentence)).toBe(
      false,
    );

    vi.advanceTimersByTime(6_900); // 9.2s after the turn — past the window
    expect(
      w.consider('can you check whether staging picked it up?', 'final', sentence),
    ).toBe(true);
  });

  it('accepts a follow-up that began while the agent was still speaking', () => {
    const w = window();
    w.arm('Mario');
    const sentence = item();

    // The live sequence, measured off a real call. The agent answered, Mario began his
    // follow-up 7.2s in — while it was still talking, which is how people actually follow
    // up — and finished 8.4s after it stopped.
    vi.advanceTimersByTime(7_200);
    expect(
      w.consider('so on that deploy, I was wondering whether', 'partial', sentence),
    ).toBe(false);

    // Audio still reaching the room. This fires per chunk, and clearing the clocks here wiped
    // the stamp of the sentence already under way.
    w.onAgentTurnStarted();
    vi.advanceTimersByTime(1_000);
    w.onAgentTurnStarted();

    vi.advanceTimersByTime(2_800);
    w.onAgentTurnEnded();

    vi.advanceTimersByTime(8_400); // past the window, measured from the turn ending
    expect(
      w.consider('can you check whether staging picked it up?', 'final', sentence),
    ).toBe(true);
    expect(w.statistics.closedBy.clock).toBe(0);
  });

  it('does not read an acknowledgement as a name aimed at somebody', () => {
    // Both sentences below are verbatim from live calls, and both were declined as questions
    // for somebody called Gotcha: the tagger reads it as a proper noun, and no grammatical test
    // separates it from a name. The first has no question mark and the second has one, which is
    // why requiring one was not enough on its own — matching the roster is what settles it.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Prismith']);

    expect(
      w.consider('Gotcha, thank you. Maybe there is something about HTTP egress or allowed domains. ' +
          'Can you check that?',
        'final',
        item(),
      ),
    ).toBe(true);
    expect(
      w.consider(
        'Gotcha, thank you, and does it support any spending limits for agents that I deploy?',
        'final',
        item(),
      ),
    ).toBe(true);
    expect(w.statistics.closedBy.vocative).toBe(0);
  });

  it('closes on a name the transcriber mangled, when that person is in the room', () => {
    // "Yari" for "Jari", from a live call, where it was answered as a follow-up though the
    // question was plainly for him. An exact roster match misses it, so the roster has to
    // tolerate a mishearing or it trades one failure for the other.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Jari']);

    expect(w.consider('Yari, do you know anything about that?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('takes being handed the floor back as a request to carry on', () => {
    // From a live call: the speaker cut the agent off mid-answer, then said this four seconds
    // later. It asks nothing, so the shape test declined it and the room got silence from an
    // agent that had just been invited to continue. A bare "Go ahead." was declined earlier in
    // the same call and the speaker had to say the agent's name to prompt it.
    const w = armed();

    expect(w.consider('Go ahead, sorry.', 'final', item())).toBe(true);
    expect(armed().consider('Oh, go ahead.', 'final', item())).toBe(true);
    expect(armed().consider('sorry, you were saying?', 'final', item())).toBe(true);
  });

  it('takes a request that arrives behind a filler word', () => {
    // Found by scoring 19 labelled utterances from real calls: "Okay, please go ahead." was
    // declined. `REQUEST_PHRASE` starts with `please` and `INVITATION` with `go ahead`, and
    // both were anchored to the sentence, which starts with "Okay,".
    expect(armed().consider('Okay, please go ahead.', 'final', item())).toBe(true);

    // With a roster, as a call always has: "Gotcha" matches nobody present, so it is not a
    // name, and the request behind it stands.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Jari']);
    expect(w.consider('Gotcha, can you check the logs?', 'final', item())).toBe(true);
  });

  it('keeps the anchoring that stops a request matching deep in a sentence', () => {
    // The two sentences that made the patterns anchored in the first place. Neither opens a
    // clause with `please` or `tell me`.
    const a = armed();
    expect(a.consider('right, let us move on please', 'final', item())).toBe(false);
    const b = armed();
    expect(b.consider('I asked Bob and he would not tell me anything', 'final', item())).toBe(false);
  });

  it('still reads moving the group along as the end, not an invitation', () => {
    // "let's carry on" contains an invitation and is the opposite of one: the hortative test
    // runs first for exactly this reason.
    const w = armed();

    expect(w.consider('right, let us carry on with the agenda', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.shape).toBe(1);
  });

  it('takes a request whose question is not the last thing said', () => {
    // Verbatim from a live call, and it was closed as a statement. The question is in the first
    // sentence and the imperative in the last, so an utterance-level test — which only looked
    // at how the whole thing began and ended — saw neither.
    const w = armed();

    expect(
      w.consider('There should be some data folder, I think, or is it in slash app? ' +
          "It's in slash data, I think, yeah. Check that",
        'final',
        item(),
      ),
    ).toBe(true);
    expect(w.statistics.closedBy.shape).toBe(0);
  });

  it('still closes on a name that is actually in the room', () => {
    // The guard's whole point, and the roster is what makes it precise rather than looser.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Jari']);

    expect(w.consider('Jari, can you check that for me?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('falls back to the tag when nobody has told it who is in the room', () => {
    // Early in a call, or on a platform with no roster at all: a proper noun beside a comma
    // is the only evidence there is, so it still counts.
    const w = armed();

    expect(w.consider('Tom, do you know the default port?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('says how late the next thing said actually was', () => {
    // The clock is evaluated when somebody speaks, not on a timer, so this line can appear long
    // after the exchange lapsed — eighty seconds later, in one live log, which read as though
    // the window had been open all that time.
    const w = armed();
    vi.advanceTimersByTime(85_000);

    w.consider('and what about staging?', 'final', item());
    expect(infoLines()).toContain('came 85.0s after my turn');
  });

  it('closes when the next thing said only begins after the window', () => {
    const w = armed();

    // The clock still closes, and on the same evidence as before: nobody started following
    // up in time. What changed is that "started" is now the test.
    vi.advanceTimersByTime(9_000);

    expect(w.consider('and what about staging?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.clock).toBe(1);
  });
});

describe('who is allowed to follow up', () => {
  it('answers anybody in the room, not only the person it was last talking to', () => {
    // Two people in a call asked for this: "it would feel more natural if anybody can keep going
    // with the agent, and only after some other name is mentioned would it be disabled." Before
    // it, a colleague picking up the thread had to say the agent's name again even though the
    // exchange was plainly still running.
    const w = armed();

    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
    expect(w.statistics.accepted).toBe(1);
  });

  it('still declines anybody who names somebody else', () => {
    // The one thing that does end it, and now the *only* thing about who: a name.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Jari']);

    expect(w.consider('Jari, can you check staging?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('lets a backchannel from anybody pass without ending the exchange', () => {
    // "yeah" is not a question or a request, so it is declined — but declining is not closing.
    // A blanket rule that ended the exchange on anybody else speaking was measured and removed:
    // one "yeah" killed every follow-up, one accepted in six minutes against four in the minute
    // after removal. With everyone eligible there is no "anybody else" left to have a rule for.
    const w = armed();

    expect(w.consider('yeah', 'final', item())).toBe(false);
    expect(w.isOpen).toBe(true);
    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
  });
});

describe('the conversation moving on', () => {
  it('closes when the floor holder makes a statement', () => {
    const w = armed();

    // "right, let us move on to the next topic" — said on a live call, and the exchange was
    // plainly over.
    expect(w.consider('right, let us move on to the next topic', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.shape).toBe(1);
    expect(w.isOpen).toBe(false);
  });

  it('closes when the floor holder turns to somebody else', () => {
    const w = armed();

    // Live: same speaker, inside the window, question-shaped — and answered by the agent.
    // The operator's words were "that question was for Pamela actually".
    expect(w.consider('Tom, do you know the default port for MySQL?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('closes when the floor holder asks the room', () => {
    const w = armed();

    // Live: accepted 813ms after the agent's turn and answered, while the model gate had
    // declined a sibling utterance with "the speaker is addressing the group". The window
    // was weaker than the gate it exists to skip.
    expect(w.consider('any takes from the team?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.group).toBe(1);
  });

  it('closes on the clock', () => {
    const w = armed();
    vi.advanceTimersByTime(8_001);

    expect(w.consider('and what about staging?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.clock).toBe(1);
  });

  it('re-opens when the agent is addressed again', () => {
    const w = armed();
    w.consider('right, let us move on', 'final', item());
    expect(w.isOpen).toBe(false);

    w.arm('Mario');
    w.onAgentTurnEnded();

    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
  });

  it('accepts a follow-up that began inside the window but took a while to say', () => {
    const w = armed();
    const sentence = item();

    // Measured on a live call: the speaker began 2.3s after the agent stopped — plainly a
    // follow-up — spent about seven seconds asking their question, and was declined because
    // the eight seconds ran out while they were still talking. The clock asks *when they
    // started*; the drift tests ask *what they said*. Judging both on the finished transcript
    // conflated the two and penalised a follow-up for being long.
    vi.advanceTimersByTime(2_300);
    expect(w.consider('so on that deploy, I was wondering', 'partial', sentence)).toBe(
      false,
    );

    vi.advanceTimersByTime(6_900); // 9.2s after the turn — past the window
    expect(
      w.consider('can you check whether staging picked it up?', 'final', sentence),
    ).toBe(true);
  });

  it('accepts a follow-up that began while the agent was still speaking', () => {
    const w = window();
    w.arm('Mario');
    const sentence = item();

    // The live sequence, measured off a real call. The agent answered, Mario began his
    // follow-up 7.2s in — while it was still talking, which is how people actually follow
    // up — and finished 8.4s after it stopped.
    vi.advanceTimersByTime(7_200);
    expect(
      w.consider('so on that deploy, I was wondering whether', 'partial', sentence),
    ).toBe(false);

    // Audio still reaching the room. This fires per chunk, and clearing the clocks here wiped
    // the stamp of the sentence already under way.
    w.onAgentTurnStarted();
    vi.advanceTimersByTime(1_000);
    w.onAgentTurnStarted();

    vi.advanceTimersByTime(2_800);
    w.onAgentTurnEnded();

    vi.advanceTimersByTime(8_400); // past the window, measured from the turn ending
    expect(
      w.consider('can you check whether staging picked it up?', 'final', sentence),
    ).toBe(true);
    expect(w.statistics.closedBy.clock).toBe(0);
  });

  it('closes when the next thing said only begins after the window', () => {
    const w = armed();

    // The clock still closes, and on the same evidence as before: nobody started following
    // up in time. What changed is that "started" is now the test.
    vi.advanceTimersByTime(9_000);

    expect(w.consider('and what about staging?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.clock).toBe(1);
  });
});

describe('a transcript that is still being written', () => {
  it('does not answer a partial, however much of a follow-up it looks like', () => {
    const w = armed();

    // Accepting early sounds harmless — the shape test has already passed — and is not. The
    // words that say who a sentence was *for* can arrive last: this opening passes every
    // test here, and belongs to "...about the rollout, Pamela?".
    expect(w.consider('And what do you think', 'partial', item())).toBe(false);
    expect(w.isOpen).toBe(true);
    expect(w.statistics.accepted).toBe(0);
  });

  it('never closes on a partial either', () => {
    const w = armed();

    // The live failure this prevents, verbatim from a call:
    //   partial "Now, we want to talk about, about, you know..."  → reads as a statement
    //   final   "...can you put together an agenda for that?"     → obviously a follow-up
    // Closing on the partial meant the finished request arrived to a shut window and the
    // speaker had to say the agent's name again.
    const sentence = item();
    expect(w.consider('Now, we want to talk about, about, you know', 'partial', sentence)).toBe(false);
    expect(w.isOpen).toBe(true);

    expect(w.consider('can you put together an agenda for that?', 'final', sentence)).toBe(true);
  });
});

describe('what counts as a continuation', () => {
  const accepted = (text: string) => armed().consider(text, 'final', item());

  it('takes a question mark, a question word or a request', () => {
    expect(accepted('and staging?')).toBe(true);
    expect(accepted('what about the node count')).toBe(true);
    expect(accepted('could you also check the logs')).toBe(true);
    expect(accepted('please run that again')).toBe(true);
  });

  it('does not take a statement', () => {
    expect(accepted('that makes sense')).toBe(false);
    expect(accepted('we deployed it on Friday')).toBe(false);
  });

  it('does not take a statement dressed up as a request', () => {
    // `please` and `tell me` used to count from anywhere in the sentence, which accepted the
    // exact "let's move on" this design says must close the window, and reported speech.
    expect(accepted('right, let us move on please')).toBe(false);
    expect(accepted("let's take that offline")).toBe(false);
    expect(accepted('I asked Bob and he would not tell me anything')).toBe(false);
    // And a bare "and" opener accepted any statement at all, as well as stopping one from
    // ever closing the window.
    expect(accepted('And I think we should just move on.')).toBe(false);
    expect(accepted('And that is why we missed the deadline.')).toBe(false);
  });

  it('still takes the requests those narrowings could have broken', () => {
    expect(accepted('please run that again')).toBe(true);
    expect(accepted('tell me the node count')).toBe(true);
    expect(accepted('And what about staging')).toBe(true);
    expect(accepted('and can you check the logs')).toBe(true);
  });

  it('does not take a question aimed at a colleague, wherever the name sits', () => {
    expect(accepted('Emma, could you take the notes for this one?')).toBe(false);
    expect(accepted('Yarin, how about you?')).toBe(false);
    // The vocative is not always the first thing said. Live: "I gotcha, thank you. Um,
    // Yari, do you have anything to add?" was answered because only the opening token of
    // the utterance was examined.
    expect(accepted('I gotcha, thank you. Um, Yari, do you have anything to add?')).toBe(false);
    // Trailing, which an earlier version could not see at all: it only looked at tokens
    // *followed* by a comma.
    expect(accepted('What do you think, Pamela?')).toBe(false);
    // No comma, which people drop constantly.
    expect(accepted('Pamela can you get the numbers?')).toBe(false);
    expect(accepted('Tom do you know the port?')).toBe(false);
    // A second sentence, where the scan used to walk the whole utterance without resetting.
    expect(accepted('Thanks for the update. Pamela, could we get the Q3 numbers?')).toBe(false);
  });

  it('recognises a name the transcriber lower-cased, given the roster', () => {
    // A lower-cased name tags as a common noun, so grammar alone cannot see it. The roster
    // is scraped anyway, and it is the same signal the caption reader uses.
    const w = armed();
    w.setRoster(['Mario Sarcher', 'Tom']);

    expect(w.consider('tom, do you know the port?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.vocative).toBe(1);
  });

  it('does not close on an ordinary noun phrase that happens to contain a group word', () => {
    // "can you ask the platform team to bump the quota?" is a request *to the agent*, and it
    // used to close the exchange on the word "team".
    expect(accepted('can you ask the platform team to bump the quota?')).toBe(true);
  });

  it('does not read a list of proper nouns as a name', () => {
    // Opens with a proper noun and a comma exactly the way a vocative does. What separates
    // them is the coordinator arriving before any verb.
    expect(accepted('Kubernetes, Slack and Bedrock are all down, can you check?')).toBe(true);
  });

  it('still takes a question that merely mentions a proper noun', () => {
    // A name in a list is not a vocative. What separates the two is what follows it, so
    // this is not caught by "a capitalised word before a comma".
    expect(accepted('and do we use Kubernetes, Slack, and Bedrock for that?')).toBe(true);
  });

  it('does not skip the model call for words it could not read', () => {
    // Greek, which the English tagger cannot parse. No verdict means no licence to answer
    // unjudged — but also no grounds to close, since being unable to read a sentence is not
    // the same as the exchange having ended.
    const w = armed();

    expect(w.consider('και μπορείς να ελέγξεις το cluster;', 'final', item())).toBe(false);
    expect(w.isOpen).toBe(true);
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
    expect(w.consider('yeah', 'final', item())).toBe(false);
    expect(w.consider('and what about staging?', 'final', item())).toBe(false);
    expect(w.statistics.closedBy.clock).toBe(0);

    w.onAgentTurnEnded();

    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
  });

  it('suspends a live window for the length of the next answer', () => {
    const w = armed();
    // A chained exchange: the follow-up is answered, so the agent speaks again.
    expect(w.consider('and what about staging?', 'final', item())).toBe(true);
    w.onAgentTurnStarted();

    // "yeah, got it" while that answer is still playing is a reaction to it, not the
    // exchange ending. Without this it one-strike closed the window against the *previous*
    // turn's clock, before the answer it reacted to had even finished.
    expect(w.consider('yeah, got it', 'final', item())).toBe(false);
    expect(w.isOpen).toBe(false);
    expect(w.statistics.closedBy.shape).toBe(0);

    w.onAgentTurnEnded();

    expect(w.consider('and what about the node count?', 'final', item())).toBe(true);
  });
});
