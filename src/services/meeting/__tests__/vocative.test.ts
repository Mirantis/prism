/**
 * The local read that decides whether a name was spoken *to* the agent.
 *
 * Every case below came out of a real call — either said into a live Google Meet, or
 * spoken through a text-to-speech voice and run through the same transcriber the
 * runtime uses, so the text is what the agent would actually have seen rather than
 * what a keyboard would produce. That is why this file is built from real calls: five
 * defects in this rule were found by phrasings nobody thought to invent, and the two
 * earlier versions of the rule that leaked passed every invented case.
 *
 * The two numbers trade against each other, and they are not equally important:
 *
 * - **A leak** is a mention answered locally — the agent interrupting a sentence
 *   about it. There is no recovery from that in a room, so leaks must be zero.
 * - **A miss** is an address the model has to judge instead. It adds the gate's
 *   ~1.3s and nothing else, because this path can only ever say yes.
 *
 * So the mention lists are assertions and the address lists are a budget. The
 * punctuation-stripped runs exist because the transcriber is unreliable about
 * commas: stripping them must not create a leak, and is allowed to cost coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { isVocativeAddress } from '../vocative';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const NAME = 'Iris';

/** Said to the agent. Answering these locally is what this path is for. */
const ADDRESSES = [
  'Iris, what time is it?',
  'what day of the week is it today, Iris?',
  'Iris can you check the production cluster for me please',
  'hey Iris',
  'Iris, could you look at the deploy pipeline and tell us if it went red overnight?',
  'Iris, any idea?',
  'what do you think, Iris',
  'Iris please summarise where we landed',
  'sorry Iris, could you repeat that',
  'Iris are you still there',
  'Iris?',
  'thanks Iris',
  // Written after the rules were frozen, and not consulted while tuning them — so
  // this half measures whether the grammar generalises rather than whether it fits.
  'Iris, remind me what the error said',
  'Iris, is the staging cluster up?',
  'could you take that one Iris',
  'Iris would you mind checking the logs',
  // The distinction no word list can express: `go` is its own lemma, so it is a base
  // form, so this is an imperative aimed at whoever was just named.
  'Iris, go ahead',
  'ok Iris, your turn',
  'Iris, we need the node count',
  'do you have an opinion here Iris?',
  'Iris, one more thing please',
  'hey Iris, morning',
  'Iris, thanks for that',
  // From a live call. The agent is named at the very end of a clause that is plainly
  // about it, and the model gate judged this addressed — so the local read must too,
  // or the two paths disagree about the same sentence.
  'the reason why I asked you to join, Iris',
];

/** Said *about* the agent. Answering any of these is the failure to design against. */
const MENTIONS = [
  'I asked Iris about that yesterday',
  'Iris said the cluster was fine',
  'that was Iris’s idea originally',
  'we should talk about Iris later',
  'I had a chat with Iris this morning',
  'Iris mentioned the deploy was red',
  'maybe someone should check with Iris first',
  'Iris was in the standup earlier',
  // An uninflected auxiliary with a verb behind it is a modal in a finite clause, so
  // the name is still its subject. Grammar, so there is no modal list to maintain.
  'Iris will probably know that one',
  'we can get Iris to do it later',
  'let Iris handle the cluster question',
  'Iris and I already went through this',
  'I think Iris already answered that in the channel',
  'has anyone else noticed Iris repeating herself',
  'that is the kind of thing Iris usually picks up',
  'Iris joined the call about ten minutes ago',
  'my worry is Iris getting it wrong in front of a customer',
  'do you remember when Iris got confused by the deploy names',
  'the whole point of having Iris here is exactly this',
  'nobody told Iris the meeting moved',
  'ask Iris later',
  'Iris said no',
  'that was Iris',
  'Iris is offline',
  'leave it to Iris',
  'Iris already knows',
  // Held out, as above.
  'Iris has been quiet this whole call',
  'someone needs to teach Iris about our naming',
  'I would trust Iris over the dashboard honestly',
  'Iris keeps answering before I finish',
  // A question, and still about the agent rather than to it.
  'is Iris even listening',
  'we added Iris to the channel last week',
  'the thing Iris built last sprint',
  'Iris took the action item on that',
  'between you and me Iris is faster than the runbook',
  'that sounds like an Iris question',
  'I will ask Iris after the call',
  'Iris does not have access to that repo',
  'lets not bother Iris with this one',
  'Iris was right about the timeout',
  // "so" opens a narrative sentence, not an address. Treating it as a greeting made
  // this the one held-out case that leaked.
  'so Iris and Mario both flagged it',
];

/**
 * Said in a live room to somebody else, or about something else.
 *
 * These are what the rule is for. Each one is a person or a thing whose name sits
 * exactly where the agent's name would sit in a genuine address, and a rule keyed on
 * "the name appears somewhere" answered all of them.
 */
const SOMEONE_ELSE = [
  'Tom, do you know what happened to the pipeline?',
  'Yarin, how about you?',
  'The Ari, do you know more about this?',
  'Dogs, do you have any thoughts',
  'Any takes from the team?',
  'we use Kubernetes, Slack, and Bedrock',
];

/**
 * Sentences a code review confirmed the first version of this answered.
 *
 * Kept apart from the corpora above because the source is different and weaker: nobody
 * said these in a room. They were written by reading the rules and looking for shapes
 * that satisfy them by accident, which makes them poor evidence about what a meeting
 * sounds like and good evidence about where the rules were loose. Three families, each
 * of which needed its own narrowing:
 *
 *   * reported speech — one human relaying the agent's output to another, which the old
 *     "any second-person pronoun anywhere" exemption read as a direct address;
 *   * an appositive or an enumeration behind the comma, identical to a vocative up to
 *     that comma;
 *   * a question *about* the agent, where the question mark was being taken as evidence
 *     that the agent was the one being asked.
 */
const CONSTRUCTED_MENTIONS: [string, string][] = [
  ['Iris said you were wrong', 'Iris'],
  ['Iris told you so', 'Iris'],
  ['Iris said you should check the deploy', 'Iris'],
  ['Iris asked you about that yesterday', 'Iris'],
  ['Iris, our agent, flagged it first', 'Iris'],
  ['Iris, the AI, said no', 'Iris'],
  ['Iris, Mario and I met yesterday to discuss it', 'Iris'],
  ['Iris, Slack and Bedrock are all down', 'Iris'],
  ['Iris, I heard, was wrong about that', 'Iris'],
  ['Who is Iris?', 'Iris'],
  ['Where is Iris?', 'Iris'],
  ["Where's Iris?", 'Iris'],
  ['Is that Iris?', 'Iris'],
  ['Was that Iris?', 'Iris'],
  ['How good is Iris?', 'Iris'],
  // The tagger read `ping` as a noun, so the object test could not catch this one. It
  // is rejected for being an unfenced trailing name instead, which holds whatever the
  // tagger made of the word in front of it.
  ['did anyone ping Iris?', 'Iris'],
];

/**
 * Addresses that must survive every narrowing the review prompted.
 *
 * Each is a shape a fix could plausibly have broken, so they are asserted next to the
 * leaks rather than only inside the big corpus: people drop the comma from an inverted
 * question all the time, and an aside mid-request is normal speech.
 */
const NARROWING_MUST_KEEP: [string, string][] = [
  ['Iris are you still there', 'Iris'],
  ['Iris would you mind checking the logs', 'Iris'],
  ['Iris did you see the alert', 'Iris'],
  ['Iris, quick question, can you check?', 'Iris'],
  ['Iris, when you get a chance, could you check?', 'Iris'],
  ['Iris, could you look at the deploy pipeline and tell us if it went red overnight?', 'Iris'],
];

/**
 * Everything an agent named Iris was actually addressed with across two live Google Meet
 * calls, transcribed by the model this runtime uses.
 *
 * The strongest corpus in this file, and the one that matters most, because it is the only
 * one nobody composed. Every entry below was said by somebody who was not thinking about
 * the parser — and five of them failed. The rules had been written and measured against
 * single, tidy, well-punctuated sentences; real speech is multi-sentence, disfluent, and
 * puts the name wherever the thought ends. On the first of those two calls the local read
 * fired **only** on a bare "Iris." or a leading vocative, and every naturally-phrased
 * address went to the model, at a cost of 1.3–2.1 seconds each.
 *
 * **Eight** of these failed before the rules were widened, and each is marked with the rule
 * that now covers it. Keep them: every one of those rules looks arbitrary without the
 * sentence that forced it.
 */
const LIVE_ADDRESSES = [
  // FAILED (segmentation, then the predicate tail): the name ends the first of two
  // sentences, so it was not "at the end" of the utterance and read as mid-clause. Once
  // each sentence is judged alone, this is a comma-fenced name closing a clause that ends
  // on an adjective.
  'That sounds pretty good, Iris. Thank you for the great summary.',
  // FAILED (segmentation): same cause, and the name ends a *question* here, so segmentation
  // alone is enough to fix it.
  'All right, so now I am thinking a bit about, you know, how could this be deployed to our own infrastructure, Iris? Are there any, so prerequisites or, you know, anything that we have to build up before we can use this, you know?',
  // FAILED (courtesy opening a clause): a courtesy immediately before the name, with a
  // sentence in front of it. The greeting exemption asked whether *every* preceding word was
  // a greeting, so plain "thanks Iris" passed and these did not.
  'Makes sense, thanks Iris.',
  'Right, thanks Iris.',
  // FAILED (courtesy opening a clause): the floor-yield. `sorry` sits directly before the
  // name and opens its own clause.
  'Oh, go ahead, sorry, Iris.',
  // FAILED (segmentation): the name is alone in the final sentence, which the transcriber
  // produced by ending the utterance right after it.
  'Can hear the music. Iris',
  // FAILED (adverb-skipping verb search): an adverb sat between the name and its imperative,
  // in the slot the imperative test was watching.
  'Okay Iris just keep on talking',
  // FAILED (inverted question overriding the edge test): three tokens of transcription noise
  // in front of an inverted question put the name mid-clause. Only admitted because the
  // sentence really ends in a question mark.
  'And  first  12  Iris can you hear music?',
  // Passed from the start, via the greeting that opens it rather than via the tail rule.
  'Okay, well, hey, go ahead, Iris.',
  // These worked from the start, and are here so a future narrowing cannot quietly break
  // the shapes the feature shipped with.
  'So, Iris, please check',
  'All right, Iris, what capability',
  'Iris, you have to explain',
  'Sure, Iris, go ahead',
  'Iris, do you know?',
  'Iris, go ahead.',
  'Iris, can you hear me',
  'Hey Iris, you are on a call with two people',
  'Iris, this is about Lens Agents',
  'Iris, what type of music',
  "Iris, I'll turn it a bit down",
  'Iris, what did we just discuss?',
  'Iris, leave the meeting',
  'Iris.',
  'Iris,',
];

/**
 * Said in the same two calls, and none of it aimed at the agent.
 *
 * Half of these are probes — a mention, reported speech, an appositive, a list ending in
 * her name — and half are simply what two people say to each other in a meeting. The
 * local read declined every one.
 */
const LIVE_NOT_ADDRESSES = [
  // Probes, spoken in the call to test the loosened rules.
  'I asked Iris about that yesterday, but I do not know what she said',
  'Iris said the cluster was fine and, you know, we moved on',
  'I think there is no Iris in this project.',
  "Yesterday's meeting, I think the attendees were Tom, Yari and Iris.",
  'Iris, our agent, flagged it first.',
  'Iris our agent flagged it first.',
  // Ordinary meeting speech that happens to contain no name at all.
  'Good stuff, nice to meet you.',
  'Why don not you look up the dog so that you have the context?',
  'Gotcha. How about network egress? How is it configured?',
  'Okay, how is the infrastructure secured?',
  'No, no further questions.',
  'Sorry for interrupting you.',
  // Colleagues addressed by name, in exactly the position the agent's name would occupy.
  'Yari, are you here as well?',
  'Yari, do you know anything about the spending limits?',
  'Miska, how about you? Do you have any questions?',
  'Tom, do you know what happened to the pipeline?',
];

const strip = (text: string) => text.replace(/[,?.!;:]/g, '');

describe('isVocativeAddress', () => {
  it('answers every address collected from a real call', async () => {
    const missed: string[] = [];
    for (const text of ADDRESSES) {
      if (!(await isVocativeAddress(text, NAME)).addressed) missed.push(text);
    }
    expect(missed).toEqual([]);
  });

  it('never answers a sentence that is about the agent', async () => {
    const leaked: string[] = [];
    for (const text of MENTIONS) {
      if ((await isVocativeAddress(text, NAME)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('answers every address two live calls produced', async () => {
    // Five of these failed when the rules were only measured against composed sentences.
    // See `LIVE_ADDRESSES` for which, and what each one taught.
    const missed: string[] = [];
    for (const text of LIVE_ADDRESSES) {
      if (!(await isVocativeAddress(text, NAME)).addressed) missed.push(text);
    }
    expect(missed).toEqual([]);
  });

  it('answers nothing that was said in those calls to somebody else', async () => {
    const leaked: string[] = [];
    for (const text of LIVE_NOT_ADDRESSES) {
      if ((await isVocativeAddress(text, NAME)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('does not read an enumeration ending in the name as an address', async () => {
    // The loosest rule here accepts a comma-fenced name closing a clause, and a list's last
    // item sits in exactly that position. What separates them is that a list's previous item
    // is itself a name or a number. Both forms tested, because the spoken one used "and"
    // and so never exercised the guard.
    for (const text of [
      'the attendees were Tom, Iris',
      'the attendees were Tom, Yari, Iris',
      'we shipped it on Friday, Monday',
    ]) {
      expect(await isVocativeAddress(text, NAME)).toMatchObject({ addressed: false });
    }
  });

  it('never answers the shapes the live-derived widenings first let through', async () => {
    // Widening the rules to cover real speech opened four holes, each found by running the
    // code rather than reading it. They are grouped by which widening admitted them, because
    // the guard that closes each one is otherwise unmotivated.
    const leaks = [
      // The inverted-question override. "you know" as a filler is byte-identical to an
      // inverted question up to the point the rule stops reading, and it is very common —
      // the address corpus above contains it three times in one utterance. These are people
      // discussing the agent's performance.
      'honestly Iris was you know a bit slow today',
      'honestly Iris was, you know, a bit slow today',
      'so Iris has, you know, been quiet today',
      'to be fair Iris has you know improved a lot',
      // Same override: do-support in a relative clause puts AUX before a second-person
      // subject of the *next* clause. None of these ends in a question mark, which is what
      // now separates them from a real inverted question.
      'whatever Iris does you should double-check',
      'what Iris did you can read in the postmortem',
      'the demo Iris did you all saw last week',
      'the stuff Iris does you all know already',
      // The comma-fenced tail. Appositives and list tails sit in that position too, and
      // usually end on a common noun or a pronoun, which excluding proper nouns and numbers
      // did not catch. "our agent, Iris" is the most natural way to refer to this bot in the
      // meetings it attends.
      'the outage was caused by our agent, Iris.',
      'it was flagged first by our agent, Iris.',
      'the report was reviewed by the team lead, Iris',
      'they renamed the bot, Iris.',
      'they rely on Slack, the dashboards, Iris',
      'the attendees were Tom, the manager, Iris.',
      'they blamed it on her, Iris',
      'that decision was made above me, Iris',
      'they invited the whole team, Iris',
      // The bare-name sentence. The transcriber inserts a break after a name mid-mention as
      // readily as at the end of an address, so only the last sentence may be a bare name.
      'Iris? I doubt she knows.',
      'I asked. Iris. about that.',
      'We should ask. Iris. later.',
      // The trailing courtesy. Reported or possessed rather than offered — none of these
      // opens its own clause.
      'he said sorry Iris',
      'he never said thanks Iris',
      'give my thanks Iris',
      'tell her sorry Iris',
    ];
    const leaked: string[] = [];
    for (const text of leaks) {
      if ((await isVocativeAddress(text, NAME)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('still answers the addresses those guards could have broken', async () => {
    // A vocative can follow a verb ("Thanks for coming, Iris"), which is why verbs are absent
    // from the predicate-tail allowlist rather than the guard being loosened: that sentence
    // passes through the greeting that opens it.
    const keep = ['Thanks for coming, Iris', 'thanks Iris', 'Iris do you know the answer'];
    const lost: string[] = [];
    for (const text of keep) {
      if (!(await isVocativeAddress(text, NAME)).addressed) lost.push(text);
    }
    expect(lost).toEqual([]);
  });

  it('never answers the shapes a review found it answering', async () => {
    const leaked: string[] = [];
    for (const [text, agent] of CONSTRUCTED_MENTIONS) {
      if ((await isVocativeAddress(text, agent)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('still answers the addresses those narrowings could have broken', async () => {
    const lost: string[] = [];
    for (const [text, agent] of NARROWING_MUST_KEEP) {
      if (!(await isVocativeAddress(text, agent)).addressed) lost.push(text);
    }
    expect(lost).toEqual([]);
  });

  it('never answers a sentence aimed at somebody else', async () => {
    const leaked: string[] = [];
    for (const text of SOMEONE_ELSE) {
      if ((await isVocativeAddress(text, NAME)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('leaks nothing when the transcriber drops the punctuation', async () => {
    const leaked: string[] = [];
    const constructed = CONSTRUCTED_MENTIONS.filter(([, agent]) => agent === NAME).map(([t]) => t);
    for (const text of [...MENTIONS, ...SOMEONE_ELSE, ...constructed].map(strip)) {
      if ((await isVocativeAddress(text, NAME)).addressed) leaked.push(text);
    }
    expect(leaked).toEqual([]);
  });

  it('still answers most addresses without punctuation, and pays for the rest in latency', async () => {
    let answered = 0;
    for (const text of ADDRESSES.map(strip)) {
      if ((await isVocativeAddress(text, NAME)).addressed) answered += 1;
    }
    // A budget, not an assertion of the exact number: the ones it loses are forms
    // where the comma was the only thing marking the vocative ("Iris, thanks for
    // that" → "Iris thanks for that", which is a sentence about thanking Iris).
    // Those go to the model, which is what happens today for every utterance.
    expect(answered).toBeGreaterThanOrEqual(16);
  });

  it('reads a name the transcriber lower-cased', async () => {
    // From a live call, and the reason the rule accepts NOUN as well as PROPN: the
    // transcriber wrote the agent's own name in lower case, and requiring a
    // proper-noun tag would have sent this to the model.
    const verdict = await isVocativeAddress('Actually, prism, can you help with that?', 'Prism');
    expect(verdict).toEqual({ addressed: true, why: 'vocative' });
  });

  it('hands a mangled name to the model instead of guessing at it', async () => {
    // A live call rendered "Prism" as "Pritham". Reading through a mishearing is the
    // model gate's job, and the local read does not try: an agent's name is arbitrary
    // user-set text, so any tolerance would have to be right for every name anyone
    // might pick. This adds the gate's ~1.3s and nothing else.
    expect(await isVocativeAddress('Irish, can you check the deploy?', NAME)).toMatchObject({
      addressed: false,
      why: 'no name',
    });
    expect(await isVocativeAddress('Pritham, are you there?', 'Prism')).toMatchObject({
      addressed: false,
      why: 'no name',
    });
  });

  it('never answers for a name that merely shares a stem with the agent', async () => {
    // The case for exact matching, and the reason the earlier four-character-prefix
    // rule was wrong: it was right about "Iris" and wrong about nine of these. Each
    // pair is a name or word somebody could plausibly say in a room where the agent is
    // called the other one — and answering a question asked of a colleague is the
    // failure this whole path is built to avoid.
    const collisions: [string, string][] = [
      ['Mario, do you know what broke?', 'Marina'],
      ['Irina, can you take that one?', 'Iris'],
      ['Sandra, are you seeing this?', 'Sandy'],
      ['Tom, could you check?', 'Tomas'],
      ['Chris, do you have the numbers?', 'Christina'],
      ['Sandbox, can you look?', 'Sandra'],
      ['Concern, do you agree?', 'Concord'],
      ['Marine, are you there?', 'Marina'],
      ['Prisma, can you check?', 'Prism'],
    ];
    const leaked: string[] = [];
    for (const [text, agent] of collisions) {
      if ((await isVocativeAddress(text, agent)).addressed) leaked.push(`${text} (agent ${agent})`);
    }
    expect(leaked).toEqual([]);
  });

  it('does not mistake a common word for the agent it shares letters with', async () => {
    // An agent's name is user-set text, so it is often an ordinary English word. The
    // tag is the only thing separating these from a real address.
    expect(await isVocativeAddress('Will you check the deploy?', 'Will')).toMatchObject({
      addressed: false,
      why: 'not a name here',
    });
    expect(await isVocativeAddress('Max out the CPU, can you check?', 'Max')).toMatchObject({
      addressed: false,
      why: 'phrase continues',
    });
    expect(await isVocativeAddress('Grace period is over, do you agree?', 'Grace')).toMatchObject({
      addressed: false,
      why: 'phrase continues',
    });
  });

  it('hands a script it cannot read to the model instead of guessing', async () => {
    // Not hypothetical: unseeded transcription rendered "hey Iris" as this, twice on
    // one call. The model gate behind this reads Greek; the English tagger does not.
    const verdict = await isVocativeAddress('Καίρις, μπορείς να ελέγξεις;', NAME);
    expect(verdict).toEqual({ addressed: false, why: 'unreadable script' });
  });

  it('reads a mostly-English sentence with one foreign word in it', async () => {
    // The seam is a share rather than all-or-nothing, so a single mis-transcribed
    // word does not cost the whole utterance its fast path.
    const verdict = await isVocativeAddress('Iris, can you check the κλάστερ?', NAME);
    expect(verdict.addressed).toBe(true);
  });

  it('says nothing about an empty transcript or a nameless agent', async () => {
    expect(await isVocativeAddress('   ', NAME)).toEqual({ addressed: false, why: 'nothing to read' });
    expect(await isVocativeAddress('Iris, hello', '')).toEqual({ addressed: false, why: 'nothing to read' });
  });
});

describe('when the tagger cannot be loaded', () => {
  it('defers to the model rather than throwing', async () => {
    // The failure that matters is a broken install or a stripped image layer. It must
    // cost the room the gate's latency, not the agent's ability to hear at all — and
    // it must be logged once, not once per utterance for the length of the call.
    vi.resetModules();
    vi.doMock('wink-nlp', () => {
      throw new Error('module not found');
    });
    const { logger } = await import('../../../logger');
    const { isVocativeAddress: withoutTagger } = await import('../vocative');

    // Concurrently, which is how it happens: a partial transcript and its finished form
    // are judged milliseconds apart at the start of a call. Memoising the load's *result*
    // rather than its promise let both get past the guard, so "logged once" was only true
    // when the two calls happened to be sequential.
    const verdicts = await Promise.all([
      withoutTagger('Iris, are you there?', NAME),
      withoutTagger('Iris, still nothing?', NAME),
      withoutTagger('Iris, and again?', NAME),
    ]);
    expect(verdicts).toEqual([
      { addressed: false, why: 'no tagger' },
      { addressed: false, why: 'no tagger' },
      { addressed: false, why: 'no tagger' },
    ]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);

    vi.doUnmock('wink-nlp');
    vi.resetModules();
  });
});
