/**
 * Was the agent's name spoken *to* it — decided locally, with no model call.
 *
 * `addressed-classifier.ts` explains why being named is judged by a model rather
 * than a string match, and all of that still holds. This is not a replacement for
 * it. It is a shortcut in front of it, and the contract is narrow enough to state
 * here too:
 *
 * **It can only ever say yes.** Anything it does not recognise as a vocative — a
 * mention, a mangled name, a language it cannot read, a tagger that threw — goes to
 * the model exactly as before. So the worst a bug in here can do is add the gate's
 * ~1.3s, which is what every gated utterance pays today. It cannot make the agent
 * quieter, and it cannot make it answer something the model would have refused,
 * unless it says yes wrongly. That is the one failure to design against, and it is
 * why the rules below are stricter than "the name is in there".
 *
 * **Why.** The gate is a network round trip. Measured on live calls it runs
 * 0.9–1.5s with a tail past 2.5s, on every utterance in a crowded room — including
 * the ones where someone plainly began the sentence with the agent's name. On
 * those, this answers in 0ms; the best end-to-end measurement was 780ms from the
 * speaker stopping to the first audio out.
 *
 * **Name presence is not the test.** Two earlier versions of this keyed on the name
 * appearing and leaked 11 of 12 and 6 of 6 third-person mentions respectively.
 * "I asked Iris about that" contains the name and is obviously not talking to it.
 * What separates addressing someone from talking about them is grammatical
 * position, so that is what is tested — all three of:
 *
 *   1. **Edge position.** A vocative sits at the start or the end of what is being
 *      said, or is fenced off by a comma, or follows nothing but a greeting. This
 *      rule rejects "ask Iris later" and "we can get Iris to do it".
 *   2. **No grammatical role.** A finite verb after the name makes the name its
 *      subject ("Iris said the cluster was fine"); a preposition or a verb before
 *      it makes it an object ("I talked to Iris", "let Iris handle it"). Either way
 *      the sentence is *about* the agent.
 *   3. **Positive evidence of address.** Second person, a question, "please", a
 *      greeting, a wh-word right after the name, or a comma fencing it off. Without
 *      one of these a name at the edge is just as likely to be a topic ("Iris is
 *      offline").
 *
 * **Why a POS tagger and not a word list.** Rule 2 turns on the distinction between
 * "Iris said no" (mention) and "Iris go ahead" (address), and no list of words can
 * express it — the difference is *inflection*. `said` has the lemma `say`, so it is
 * a finite verb and the name in front of it is its subject. `go` has the lemma `go`,
 * so it is a base form, so the sentence is an imperative aimed at whoever was just
 * named. One rule instead of two hand-written lists of English morphology — and
 * hand-written lists are what leaked in both earlier versions.
 *
 * **The tagger is English-only, and this file states it.** wink's
 * `wink-eng-lite-web-model` is the only model that exists, so `readsScript()`
 * declares what this path can read and everything else defers. That does *not* make
 * the agent English-only: the model gate behind this is language-agnostic, and a
 * deferral goes to it unchanged. This is not hypothetical — unseeded
 * transcription rendered "hey Iris" as the Greek "Καίρις" twice on one call, and
 * both took the deferral rather than being mis-parsed as English. Supporting a
 * second language means adding a reader here and touching nothing else.
 */

import type { ItsFunction } from 'wink-nlp';
import { logger } from '../../logger';

/**
 * Why this path decided what it did.
 *
 * A bounded enum rather than a sentence, on purpose: this is written to the
 * log on every utterance, and a reason built by quoting the sentence ("name is the
 * subject of *said*") would put a word of the room's speech in the log under
 * `MEETING_TRANSCRIPT_LOGGING=off` — the one thing `transcript-log.ts` exists to
 * prevent. These names describe the grammar, never the words.
 */
export type VocativeReason =
  /** All three rules held: someone said the name *to* the agent. */
  | 'vocative'
  /** No word in the text resembles the name. By far the most common case. */
  | 'no name'
  /** A word matched the letters but is doing a function word's job here. */
  | 'not a name here'
  /** Rule 1: the name sits inside a clause, unfenced. */
  | 'mid-clause'
  /** Rule 2: the name is the subject or object of a verb. */
  | 'has a grammatical role'
  /** Rule 1: the name opens the text but what follows continues its phrase. */
  | 'phrase continues'
  /** Rule 3: the name is at an edge, but nothing says it was being addressed. */
  | 'third-person statement'
  /** Rule 1: a coordinator follows the name, so it is an item in a list. */
  | 'listed with others'
  /** Not a script the English tagger can read. */
  | 'unreadable script'
  /** The tagger could not be loaded at all. */
  | 'no tagger'
  /** The tagger threw on this text. */
  | 'tagger failed'
  /** An empty transcript, or no agent name to look for. */
  | 'nothing to read';

/** What this path decided, and the reason that goes in the log line. */
export interface VocativeVerdict {
  /** True only when all three rules hold. Never a guess. */
  addressed: boolean;
  why: VocativeReason;
}

/**
 * Words that may sit in front of a vocative without giving the name a role.
 *
 * Not a general-purpose list, and it does not decide the verdict the way the earlier
 * verb lists did: everything here is something people say *before* addressing someone
 * ("hey Iris", "sorry Iris, could you repeat that", "ok Iris, your turn"). A wrong
 * entry costs a deferral, not a wrong answer.
 */
const GREETING = /^(ok|okay|oh|sorry|hey|hi|hello|thanks|thank|morning|afternoon|yes|no|yeah)$/i;

/**
 * Courtesies that come immediately before a name at the end of a sentence.
 *
 * Overlaps `GREETING` but is not the same list. The trailing-name rule has to
 * let through "Makes sense, thanks Iris" and "Oh, go ahead, sorry, Iris" — both live
 * utterances — while `GREETING` in that position would also admit "there is no Iris", where
 * `no` is a determiner rather than an acknowledgement. These are the words people actually
 * put in front of a name when they close a turn with it or hand over the floor.
 */
const TRAILING_COURTESY = /^(thanks|thank|cheers|ta|sorry|please)$/i;

/** Question words. Used both for "is this a question" and for "wh-word after the name". */
const WH_WORD = /^(what|where|when|why|how|who|whom|which|whose)$/i;

/** Second-person pronouns — the strongest single sign that a sentence is directed. */
const SECOND_PERSON = /^(you|your|yours|yourself)$/i;

/**
 * First-person plural, as a subject or an object. "Iris, we need the node count" and
 * "Iris, give us a minute" are both addressed rather than narrated.
 *
 * `our` is absent on purpose. It is a possessive determiner, so it modifies whatever
 * noun follows it rather than standing in for anybody being spoken to — which is exactly
 * the shape of an appositive about the agent. With `our` in this list, the
 * comma-stripped "Iris our agent flagged it first" read as an address.
 */
const INCLUSIVE = /^(we|us)$/i;

/** Politeness markers, which only appear in requests. */
const REQUEST = /^(please|pls)$/i;

/**
 * Tags a name cannot have.
 *
 * An agent's name is user-set text, so it is often also an ordinary English word —
 * Max, Will, May, Mark, Grace, Sage, Echo. When such a word is doing a function
 * word's job it is not a name being called: "Will you check the deploy?" opens with
 * an auxiliary, not with an address to an agent called Will. Reading the tag is the
 * only way to tell those apart, since the letters are identical.
 *
 * Nominal tags are all allowed, PROPN and NOUN alike: transcription lower-cases a
 * name often enough that requiring PROPN would throw away real addresses — a live
 * call rendered "Actually, prism, can you help with that?" with
 * `prism` tagged NOUN, and that is exactly the utterance this path exists to answer
 * without a model call.
 */
const NEVER_A_NAME = new Set([
  'AUX',
  'VERB',
  'DET',
  'PRON',
  'ADP',
  'CCONJ',
  'SCONJ',
  'PART',
  'NUM',
  'SYM',
]);

/**
 * What may follow a name that opens the sentence with no comma after it.
 *
 * With a comma, the name is fenced off and plainly a vocative. Without one, the
 * only thing separating "Iris can you check the cluster" from "Grace period is
 * over" is what comes next: a clause aimed at somebody starts with an auxiliary, a
 * verb, a pronoun, an adverb, an interjection or a wh-word, while a name followed by
 * a noun, a number or a preposition is part of that phrase rather than being
 * addressed ("Grace period", "Max out the CPU").
 */
const CLAUSE_HEAD = new Set(['AUX', 'VERB', 'PRON', 'INTJ', 'ADV', 'PART']);

/**
 * How much of the text has to be in a script the tagger was built for.
 *
 * A share rather than all-or-nothing because real transcripts mix scripts — a
 * mostly-English sentence with one mis-transcribed word in it should still be read,
 * while "Καίρις, μπορείς να..." should not. Six in ten is well clear of both.
 */
const MIN_LATIN_SHARE = 0.6;

/** One token as the tagger sees it. */
interface Token {
  text: string;
  /** Universal POS tag: PROPN, VERB, AUX, ADP, PRON, PUNCT, … */
  pos: string;
  lemma: string;
}

type Tokenizer = (text: string) => Token[];

/** Punctuation and whitespace are structure, not words. Read separately where they matter. */
const isWord = (t: Token) => t.pos !== 'PUNCT' && t.pos !== 'SPACE';

/**
 * The tagger, loaded on first use and then kept.
 *
 * Lazy because it is not free and most containers never hold a meeting: measured at
 * 58ms to load and **70MB of RSS**, which is a lot to spend at boot for a feature
 * behind an `OPENAI_API_KEY` that may not be set. `await import()` is how the rest
 * of the meeting code defers its heavy dependencies (`browser-stack.ts` does it for
 * playwright), and it is the only reason the function below is async — the decision
 * itself is pure and synchronous.
 *
 * `null` records that loading failed, so a missing dependency costs one warning
 * rather than one per utterance for the length of the call.
 */
let loading: Promise<Tokenizer | null> | undefined;

/**
 * The loaded tagger, once it exists.
 *
 * Held separately from the promise so there can be a *synchronous* reader. The load is
 * async; tagging is not, and the follow-up window has to decide inside
 * `ResponsePolicy.onTranscript`, which every caller relies on being synchronous — making
 * it async would put an await between an utterance arriving and the per-item duplicate
 * check that stops the room hearing the same reply twice.
 *
 * `undefined` means "not loaded yet", `null` means "tried and failed". A reader must not
 * conflate either with "nothing found": see `ThirdPartyRead`.
 */
let tokenizer: Tokenizer | null | undefined;

/**
 * Load the tagger now.
 *
 * Called when a call starts, so the synchronous readers below can answer from the first
 * utterance. Without it they would decline for the opening seconds of a call — safe, but
 * exactly when the first exchange happens.
 */
export async function warmVocativeTagger(): Promise<void> {
  await loadTokenizer();
}

function loadTokenizer(): Promise<Tokenizer | null> {
  // The *promise* is memoised, not its result. Two utterances are often judged within
  // milliseconds of each other at the start of a call — a partial transcript and its
  // finished form — and memoising the result let both get past the guard and build a
  // second 70MB tagger, or log the "once" warning twice on the failure path.
  loading ??= buildTokenizer().then((built) => {
    tokenizer = built;
    return built;
  });
  return loading;
}

async function buildTokenizer(): Promise<Tokenizer | null> {
  try {
    const [{ default: winkNLP }, { default: model }] = await Promise.all([
      import('wink-nlp'),
      import('wink-eng-lite-web-model'),
    ]);
    const nlp = winkNLP(model);
    // Cast because wink's own `its.pos` / `its.lemma` are declared with a parameter
    // list that does not match the `ItsFunction` its `out()` accepts — an upstream
    // typing mismatch, not a wrong call. Both really do produce one string per token.
    const pos = nlp.its.pos as unknown as ItsFunction<string>;
    const lemma = nlp.its.lemma as unknown as ItsFunction<string>;
    return (text: string) => {
      const tokens = nlp.readDoc(text).tokens();
      const texts = tokens.out();
      const tags = tokens.out(pos) as string[];
      const lemmas = tokens.out(lemma) as string[];
      return texts.map((word, i) => ({ text: word, pos: tags[i] ?? '', lemma: lemmas[i] ?? '' }));
    };
  } catch (error) {
    logger.warn({ err: error }, '[Meeting:Gate] No POS tagger — every utterance will ask the model');
    return null;
  }
}

/**
 * Is this text in a script the tagger can read?
 *
 * Latin-script share is a cheap proxy. It is not a language detector — it answers
 * "was this written in the alphabet the English model was trained on", which is the
 * question that decides whether tagging it means anything. Text with no letters at
 * all (a number, a stray "?") reads as fine, because there is nothing in it to
 * mis-parse.
 */
function readsScript(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return true;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, '').length;
  return latin / letters.length >= MIN_LATIN_SHARE;
}

/**
 * Is this heard word the agent's name? Exact, ignoring case. Lowercase `name` expected.
 *
 * **Not fuzzy**, on purpose, and this is the decision here that needs the most
 * explanation. Transcription does mangle names — a live call rendered "Prism" as
 * "Pritham" — but reading through a mishearing is what the model gate exists to do, and
 * repeating its hardest job in a local heuristic is where a local heuristic leaks. An
 * agent's name is arbitrary user-set text, so any tolerance has to hold for *every*
 * name somebody might choose, not for the one in front of us.
 *
 * An earlier version accepted a shared four-character prefix. Against seventeen
 * heard-word/agent-name pairs it was wrong nine times, and not marginally: a colleague
 * called **Mario** matched an agent called **Marina**, `sandbox` matched Sandra,
 * `concern` and `concept` both matched Concord. Answering a question somebody asked
 * Mario is exactly the failure this path is built to avoid. A one-edit-distance
 * rule got that down to two, both genuinely ambiguous (`marine`/Marina,
 * `prisma`/Prism).
 *
 * Phonetic matching was measured too, since it is the obvious alternative —
 * `soundex-code`, `metaphone`, `double-metaphone` and Jaro-Winkler, on the same pairs.
 * Double-metaphone was the best of them and the only rule that recovered a mangling
 * that really happened, collapsing both "ares" and "aras" onto the agent's own code.
 * It also leaked three, including `all` onto an agent called Al: collapsing vowels is
 * the same property that recovers a mishearing. None of the four recovered "Pritham"
 * for "Prism", the mangling this feature is best known for.
 *
 * None of it helped where it counts. On real transcriber output — 64
 * utterances, three voices, through the model this runtime uses — exact matching and
 * double-metaphone find the name in **the same 23 of 23 addresses** once the name is
 * seeded to the transcriber as a keyword, which is what production does on every call.
 * The gap only opens on the unseeded run (21/23 against 19/23), a configuration that
 * has not shipped since keyword seeding did. Across every corpus the only case
 * separating exact from one-edit is a written "Irish" for "Iris".
 *
 * So the split is clear: this path takes the easy case in 0ms, and the hard case goes
 * to the model.
 *
 * The consequence to know: an agent whose name is two words, or written in a script
 * the tagger cannot read, never matches here at all. Every one of its utterances goes
 * to the model — the behaviour before this path existed.
 */
function looksLikeName(word: string, name: string): boolean {
  return word.toLowerCase() === name;
}

/**
 * The three rules, over tagged tokens. Pure, and the whole of the decision.
 *
 * One sentence at a time — see the comment inside for the two live utterances that made
 * that necessary.
 */
function decide(toks: Token[], name: string): VocativeVerdict {
  // One sentence at a time. An earlier version read the whole utterance, on the grounds
  // that the comma test already rescues a vocative with a clause *before* it — which said
  // nothing about one with a whole sentence *after* it, and that is what ordinary speech
  // produces. Two live examples, minutes apart:
  //
  //   "…how could this be deployed to our own infrastructure, Iris? Are there any…"
  //   "That sounds pretty good, Iris. Thank you for the great summary."
  //
  // In both, the name ends the first sentence and the speaker continues, so `atEnd` was
  // false and a plain trailing vocative read as mid-clause. Both went to the model, which
  // answered them correctly a second and a half later.
  const sentences = splitSentences(toks);
  let verdict: VocativeVerdict = { addressed: false, why: 'no name' };
  let sawName = false;

  sentences.forEach((sentence, index) => {
    const spoken: number[] = [];
    sentence.forEach((t, i) => {
      if (isWord(t) && looksLikeName(t.text, name)) spoken.push(i);
    });
    if (spoken.length === 0 || verdict.addressed) return;
    sawName = true;
    // Whether this is the last thing said. Only the closing sentence may be a bare name —
    // see `judgeOccurrence`.
    verdict = judgeSentence(sentence, spoken, index === sentences.length - 1);
  });

  return sawName ? verdict : { addressed: false, why: 'no name' };
}

/** Break a token stream at sentence-final punctuation. Shared by both readers in this file. */
function splitSentences(toks: Token[]): Token[][] {
  const sentences: Token[][] = [];
  let current: Token[] = [];
  for (const token of toks) {
    current.push(token);
    if (/^[.?!]+$/.test(token.text)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

/** Every occurrence of the name within one sentence; the first that reads as an address wins. */
function judgeSentence(sentence: Token[], spoken: number[], isLastSentence: boolean): VocativeVerdict {

  // Every occurrence gets a look, and the first that reads as an address wins. A name can
  // appear twice in one sentence with only the second one being an address.
  let verdict: VocativeVerdict = { addressed: false, why: 'no name' };
  for (const nameAt of spoken) {
    verdict = judgeOccurrence(sentence, nameAt, isLastSentence);
    if (verdict.addressed) return verdict;
  }
  return verdict;
}

/**
 * Does a coordinator turn up after the name before any verb does?
 *
 * "Iris, Mario and I met yesterday" — `and` arrives while the sentence is still naming
 * things, so the name is one of them. Bounded by the first verb because a coordinator
 * *after* the verb joins clauses rather than names: "Iris, could you look at the
 * pipeline and tell us if it went red" is a genuine request.
 */
function coordinatedBeforeAnyVerb(words: Token[], nameAt: number): boolean {
  for (const token of words.slice(nameAt + 1)) {
    if (token.pos === 'VERB' || token.pos === 'AUX') return false;
    if (token.pos === 'CCONJ') return true;
  }
  return false;
}

/**
 * Does a finite verb pick up immediately after the next comma?
 *
 * That is the shape of an aside about the named thing — "Iris, our agent, flagged it
 * first" — where the name is the subject of the verb that resumes. Finite means
 * inflected: `flagged`, `said`, `was`. An uninflected verb or modal after the comma is
 * a request resuming ("Iris, when you get a chance, could you check?"), not a
 * predicate about the agent.
 */
function finiteVerbAfterAside(toks: Token[], nameAt: number): boolean {
  const nextComma = toks.findIndex((t, i) => i > nameAt + 1 && t.text === ',');
  if (nextComma < 0) return false;
  const resumes = toks.slice(nextComma + 1).find(isWord);
  if (resumes === undefined) return false;
  if (resumes.pos !== 'VERB' && resumes.pos !== 'AUX') return false;
  return resumes.text.toLowerCase() !== resumes.lemma.toLowerCase();
}

/** Whether *this* occurrence of the name is being used to address the agent. */
function judgeOccurrence(toks: Token[], nameAt: number, isLastSentence: boolean): VocativeVerdict {
  if (NEVER_A_NAME.has(toks[nameAt].pos)) return { addressed: false, why: 'not a name here' };

  const words = toks.filter(isWord);
  const wordAt = words.findIndex((t) => t === toks[nameAt]);
  const before = words.slice(0, wordAt);
  const next = words[wordAt + 1];
  const prev = before[before.length - 1];

  // Punctuation is read from the tokens either side of the name rather than by
  // matching the name back into the raw text: a regex built from a heard word is a
  // regex built from user-shaped input, and the token stream already knows.
  const commaAfter = toks[nameAt + 1]?.text === ',';
  const commaBefore = toks[nameAt - 1]?.text === ',';

  // Read the verb around the name first: one of its shapes can satisfy rule 1 on its own.
  //
  // The verb is looked for *past* any adverbs and particles rather than only in the very
  // next slot. Live: "Okay Iris just keep on going" read as a third-person statement,
  // because `just` occupied the position the imperative test was watching. Skipping those
  // strengthens the mention test at the same time — "Iris probably knows that" now finds
  // `knows`, sees it inflected, and rejects on the subject rule rather than by accident.
  const skippable = (t: Token) => t.pos === 'ADV' || t.pos === 'PART';
  const afterName = words.slice(wordAt + 1);
  const verb = afterName.find((t) => !skippable(t));
  const verbAfter = verb !== undefined && (verb.pos === 'VERB' || verb.pos === 'AUX');
  const inflected = verbAfter && verb.text.toLowerCase() !== verb.lemma.toLowerCase();
  const beyondVerb = verbAfter ? afterName.slice(afterName.indexOf(verb) + 1) : [];
  // An auxiliary and the listener, right behind the name: "Iris can you hear me". The
  // inverted-question form, which happens when the name is being spoken to.
  //
  // Except for one bigram that is identical up to this point and very common in speech:
  // "you know" as a filler. `Iris was you know a bit slow today` has AUX + second-person
  // exactly like an inverted question, and it is somebody discussing the agent's performance
  // — exactly the sentence it must not interrupt. The commas do not distinguish them
  // either, since punctuation is filtered out of `words`. So the filler is excluded by the
  // lemma of what follows the pronoun, which also closes the same hole in the rule-2
  // exemption below, where it predates these changes.
  const fillerYouKnow = beyondVerb[1]?.lemma.toLowerCase() === 'know';
  const invertedQuestion =
    verbAfter &&
    verb.pos === 'AUX' &&
    beyondVerb[0] !== undefined &&
    beyondVerb[0].pos === 'PRON' &&
    SECOND_PERSON.test(beyondVerb[0].text) &&
    !fillerYouKnow;

  /** Does this sentence actually end in a question mark? */
  const endsWithQuestion = /^[?]+$/.test(toks[toks.length - 1]?.text ?? '');

  // A sentence that is nothing but the name, in the middle of an utterance, is a mention
  // being punctuated oddly rather than somebody being called: "Iris? I doubt she knows.",
  // "I asked. Iris. about that." Rejected before any evidence is weighed, because the
  // question mark on "Iris?" would otherwise count as one.
  if (words.length === 1 && !isLastSentence) {
    return { addressed: false, why: 'third-person statement' };
  }

  // 1. Edge position.
  const onlyGreetingBefore = before.length > 0 && before.every((t) => GREETING.test(t.text));
  const atStart = before.length === 0 || onlyGreetingBefore;
  const atEnd = wordAt === words.length - 1;
  // An inverted question overrides the edge test, but only in a sentence that really is a
  // question. Transcription puts junk in front of a name often enough to matter: "And  first
  // 12  Iris can you hear music?" was a plain address that read as mid-clause because of
  // three tokens of noise before it.
  //
  // The question mark is what keeps this narrow. Mid-clause, `AUX + you` is more often
  // do-support in a relative clause than an address — "whatever Iris does you should
  // double-check", "what Iris did you can read in the postmortem" — and none of those ends
  // in a question mark while every motivating case does.
  if (!atStart && !atEnd && !commaAfter && !(invertedQuestion && endsWithQuestion)) {
    return { addressed: false, why: 'mid-clause' };
  }
  // An unfenced name at the head is only an address if a clause follows it.
  if (atStart && !atEnd && !commaAfter && !CLAUSE_HEAD.has(next?.pos ?? '') && !WH_WORD.test(next?.text ?? '')) {
    return { addressed: false, why: 'phrase continues' };
  }

  const secondPerson = words.some((t) => t.pos === 'PRON' && SECOND_PERSON.test(t.text));

  // 2. Grammatical role, from tags and inflection.
  // An *uninflected* auxiliary followed by a verb or an adverb is a modal in a
  // finite clause — "Iris will probably know that one" — so the name is still its
  // subject. Grammar again, so there is no modal list to maintain.
  const modalClause =
    verbAfter &&
    verb.pos === 'AUX' &&
    beyondVerb[0] !== undefined &&
    (beyondVerb[0].pos === 'VERB' || beyondVerb[0].pos === 'ADV');
  // `invertedQuestion` (computed above) is what overrides a finite verb after the name —
  // "Iris are you still there", "Iris did you see it", where people drop the comma
  // constantly. Narrow on purpose: an earlier version exempted any sentence containing a
  // second-person pronoun *anywhere*, which answered reported speech about the agent.
  // "Iris said you should check the deploy" is one human relaying the agent's output to
  // another, and it was judged a vocative. The auxiliary is what distinguishes them —
  // `said`, `told` and `asked` tag VERB, so they no longer escape.
  if (verbAfter && !commaAfter && (inflected || modalClause) && !invertedQuestion) {
    return { addressed: false, why: 'has a grammatical role' };
  }
  if (
    prev !== undefined &&
    !onlyGreetingBefore &&
    !commaBefore &&
    (prev.pos === 'ADP' || prev.pos === 'VERB')
  ) {
    return { addressed: false, why: 'has a grammatical role' };
  }
  // A trailing name that nothing fences is a predicate or an object, not somebody being
  // called: "Who is Iris?", "Where's Iris?", "Is that Iris?", "did anyone ping Iris?".
  // The question mark is no evidence at all there — the question is *about* the agent —
  // and this catches the shape whatever the tagger made of the word in front (it read
  // `ping` as a noun, which slipped past the object test above).
  //
  // A comma, a bare greeting, second person or the name standing alone all still count:
  // "what do you think, Iris", "thanks Iris", "could you take that one Iris", "Iris?".
  // A courtesy right in front of the name is the other way people close a turn with one:
  // "Makes sense, thanks Iris." Tested on the immediately preceding word rather than on
  // the whole run before it, which is what `onlyGreetingBefore` asks — that only covers
  // "thanks Iris" with nothing else said, and live speech puts a sentence in front of it.
  // ...and it has to open its own clause to count.
  //
  // A courtesy that is offered starts a fresh breath: "Makes sense, thanks Iris", "Right,
  // thanks Iris", "Oh, go ahead, sorry, Iris" — each has a comma in front of it, or nothing
  // at all. A courtesy sitting mid-clause is being reported or is somebody's object: "he
  // said sorry Iris", "give my thanks Iris", "tell her sorry Iris". All three are genuinely
  // ambiguous as speech, so they belong to the model rather than to this shortcut.
  let prevRaw = nameAt - 1;
  while (prevRaw >= 0 && !isWord(toks[prevRaw])) prevRaw -= 1;
  const courtesyOpensClause = prevRaw <= 0 || toks[prevRaw - 1]?.text === ',';
  const courtesyBefore =
    prev !== undefined && TRAILING_COURTESY.test(prev.text) && courtesyOpensClause;
  if (atEnd && !atStart && !commaBefore && !onlyGreetingBefore && !courtesyBefore && !secondPerson) {
    return { addressed: false, why: 'has a grammatical role' };
  }
  // A name fenced off by a comma is usually a vocative, but two everyday shapes about
  // the agent look identical up to that comma, and both were answered:
  //
  //   * an enumeration — "Iris, Mario and I met yesterday", "Iris, Slack and Bedrock
  //     are all down" — where a coordinator arrives before any verb does, so the name
  //     is an item in a list rather than the person being spoken to;
  //   * an appositive — "Iris, our agent, flagged it first", "Iris, I heard, was wrong
  //     about that" — where a second comma closes an aside and a *finite* verb follows
  //     it, which makes the name that verb's subject.
  //
  // The finiteness test is what keeps genuine asides working: "Iris, when you get a
  // chance, could you check?" resumes on an uninflected modal, not a finite verb.
  if (commaAfter) {
    if (coordinatedBeforeAnyVerb(words, wordAt)) {
      return { addressed: false, why: 'listed with others' };
    }
    if (finiteVerbAfterAside(toks, nameAt)) {
      return { addressed: false, why: 'has a grammatical role' };
    }
  }

  // 3. Positive evidence that this is directed speech.
  // A sentence that is nothing but the name, and is the last thing said: "Can hear the
  // music. Iris". Restricted to the final sentence because the transcriber inserts a break
  // after a name mid-*mention* just as readily as at the end of an address — "Iris? I doubt
  // she knows." and "I asked. Iris. about that." both put the name alone in a sentence, and
  // neither is talking to it.
  const nameAlone = words.length === 1 && isLastSentence;
  const question =
    /^[?]+$/.test(toks[toks.length - 1]?.text ?? '') || WH_WORD.test(words[0]?.text ?? '');
  const inclusive = words.some((t) => t.pos === 'PRON' && INCLUSIVE.test(t.text));
  const asked = words.some((t) => REQUEST.test(t.text));
  // A greeting is evidence only for the bare "hey Iris" form. Left unqualified it
  // made "no Iris and Mario both flagged it" read as an address.
  const greeted =
    atEnd && (onlyGreetingBefore || courtesyBefore || GREETING.test(words[0]?.text ?? ''));
  const whAfterName = next !== undefined && WH_WORD.test(next.text);
  // Rule 2 already ruled out a finite verb, so a verb here is a base form: an
  // imperative, which by definition has an addressee.
  const imperative = verbAfter && !inflected && !modalClause;

  // A comma-fenced name closing a clause, where the clause it closes ends on a predicate:
  // "That sounds pretty good, Iris." Nothing else in that sentence marks it as directed — no
  // question, no second person, no courtesy — and it is still plainly a vocative.
  //
  // An allowlist rather than a blocklist, and the difference matters. Excluding proper
  // nouns and numbers was not nearly enough, because the two shapes that usually occupy
  // this position are an appositive and a list, and both often end on a common noun or a
  // pronoun: "the outage was caused by our agent, Iris", "they rely on Slack, the
  // dashboards, Iris", "they blamed it on her, Iris". Naming what a vocative *does* follow —
  // an adjective, an adverb, an interjection — admits the live cases ("pretty good, Iris",
  // "go ahead, Iris") and none of those.
  //
  // Verbs are absent even though a vocative can follow one, because the tagger reads a
  // noun-phrase head as a verb often enough to matter: "the team lead, Iris" tags `lead`
  // as VERB. The genuine cases pass another way — "Thanks for coming, Iris" through the
  // greeting that opens it.
  const PREDICATE_TAIL = new Set(['ADJ', 'ADV', 'INTJ']);
  const fencedTail = atEnd && commaBefore && prev !== undefined && PREDICATE_TAIL.has(prev.pos);

  if (
    nameAlone ||
    fencedTail ||
    invertedQuestion ||
    question ||
    secondPerson ||
    inclusive ||
    asked ||
    greeted ||
    whAfterName ||
    imperative ||
    commaAfter
  ) {
    return { addressed: true, why: 'vocative' };
  }
  return { addressed: false, why: 'third-person statement' };
}

/**
 * Did the speaker address the agent by name? Yes, or "ask the model".
 *
 * Never throws, and never says no for a reason the caller has to interpret: a
 * `false` verdict means "this path has nothing to offer", whatever the `why` says.
 */
export async function isVocativeAddress(
  transcript: string,
  agentName: string,
): Promise<VocativeVerdict> {
  const text = transcript.trim();
  const name = agentName.trim().toLowerCase();
  if (text === '' || name === '') return { addressed: false, why: 'nothing to read' };
  if (!readsScript(text)) return { addressed: false, why: 'unreadable script' };

  const tokenize = await loadTokenizer();
  if (tokenize === null) return { addressed: false, why: 'no tagger' };

  try {
    return decide(tokenize(text), name);
  } catch (error) {
    // A tagger failure decides nothing. Same direction as an unreadable script.
    logger.debug(`[Meeting:Gate] Tagger failed, asking the model: ${String(error)}`);
    return { addressed: false, why: 'tagger failed' };
  }
}

/**
 * Discourse markers this tagger reads as proper nouns.
 *
 * Deliberately tiny, and it is worth saying why it is allowed to exist at all when the
 * refuted versions of this file died of hand-written word lists. The rule below asks the
 * tagger "is this a name", and for 27 of the 33 words an earlier regex version had to
 * enumerate — `no`, `yes`, `well`, `ok`, `sure`, `right`, `actually`, `anyway`, `now`,
 * `then`, `also`, `but`, `and`, `so`, `hey`, `hi`, `hello`, `sorry`, `thanks`, `thank`,
 * `uh`, `oh`, `look`, `listen`, `everyone`, `first` — the answer is already no, because
 * they tag as determiners, interjections, adverbs, adjectives, conjunctions, verbs or
 * pronouns. These are the residue: the tagger really does call them proper nouns, and
 * "Um, could you..." is a follow-up rather than a question for somebody called Um.
 *
 * Group words like `guys` and `folks` are also tagged PROPN and are also not names, but
 * they belong to the group-vocative test in `follow-up-window.ts` rather than here — a
 * question thrown at the room is a different thing from one aimed at one person, and it
 * is worth counting separately.
 */
const NOT_A_NAME = /^(um+|second)$/i;

/**
 * Edits tolerated between a spoken word and a name on the roster.
 *
 * Live transcription mangles names — "Jari" came back as "Yari" and "Miska" as "Mees" — so an
 * exact roster match would miss the third party it is looking for. Scaled by length because one
 * edit in four letters is a much looser claim than one in eight: too generous on short names and
 * "Okay" starts matching a colleague called Omar.
 */
function nameEditBudget(length: number): number {
  if (length < 4) return 0;
  return length >= 6 ? 2 : 1;
}

/** Whether a word is a roster name, allowing for a mishearing. */
function nearAKnownName(word: string, known: Set<string>): boolean {
  const budget = nameEditBudget(word.length);
  if (budget === 0) return false;
  for (const name of known) {
    if (Math.abs(name.length - word.length) > budget) continue;
    if (withinEdits(word, name, budget)) return true;
  }
  return false;
}

/**
 * Levenshtein distance, answered as "within `budget`?" and abandoned as soon as it cannot be.
 *
 * Hand-rolled rather than a dependency: it is a dozen lines, runs over a handful of roster
 * names per sentence, and a phonetic algorithm would not help with the manglings that actually
 * occur — Soundex and Metaphone both key on the first letter, so "Jari" and "Yari" differ under
 * either.
 */
function withinEdits(a: string, b: string, budget: number): boolean {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > budget) return false;
    previous = row;
  }
  return previous[b.length] <= budget;
}

/** How far past a name a second-person pronoun still counts as being addressed to it. */
const VOCATIVE_REACH_WORDS = 4;

/**
 * Tags with meaning, as opposed to the ones a sentence can open with harmlessly.
 *
 * Used to find the first *real* word of a sentence. Everything absent from this set —
 * interjections, adverbs, conjunctions, particles, punctuation — is something people put
 * in front of a vocative ("ok Emma,", "so Tom,", "and Emma,", "um, Yari,").
 */
const LEXICAL = new Set(['NOUN', 'PROPN', 'VERB', 'AUX', 'PRON', 'ADJ', 'NUM', 'DET', 'ADP']);

/**
 * Whether somebody else was named, when that can be read at all.
 *
 * Three-valued on purpose. "The tagger is not available" and "nobody else was named" must
 * not collapse into one answer, because the caller uses this to decide whether it may
 * skip a model call: reading the first as the second would let it answer an utterance it
 * never actually examined.
 */
export type ThirdPartyRead =
  /** Read successfully. `name` is who else was addressed, or null if nobody was. */
  | { read: true; name: string | null }
  /** No verdict — the tagger is not loaded, or this is not a script it reads. */
  | { read: false };

/**
 * Was this said *to somebody other than the agent*?
 *
 * The question a follow-up window needs and the addressed gate does not. Being inside a
 * window means the person who was talking to the agent is still talking — not that they
 * are still talking *to the agent*. Live, the same speaker turned to a colleague inside
 * the window ("Tom, do you know the default port for MySQL?") and the agent answered; the
 * operator's words were "that question was for Pamela actually".
 *
 * Four positions a vocative is found in, each of which had to be added because a version
 * without it answered somebody else's question:
 *
 *   1. **Opening a sentence, fenced by a comma** — "Tom, do you know…". Every sentence,
 *      not just the first: "I gotcha, thank you. Um, Yari, do you have anything to add?"
 *      was answered because the scan never reset at the full stop.
 *   2. **Opening a sentence with no comma at all** — "Pamela can you get the numbers?".
 *      People drop that comma constantly, and without this the whole utterance is
 *      invisible to the guard.
 *   3. **Closing a sentence, fenced by a comma** — "What do you think, Pamela?". The
 *      earlier version only looked at tokens *followed* by a comma, so a trailing
 *      vocative — the second most common form there is — was never seen.
 *   4. **Fenced mid-sentence, with second person just behind it.** This catches a vocative
 *      the position rules cannot see, because transcription turns a name into a phrase:
 *      "Yari" came back as "The Ari, do you know more about that topic?", where the
 *      sentence opens with a determiner.
 *
 * Positions 1 to 3 also require the sentence to be *addressed* — second person somewhere,
 * or a question mark — so "Monday, we should ship" and "I'll do it on Tuesday, Wednesday"
 * are not read as talking to somebody called Monday. Position 4 requires second person by
 * construction. An enumeration is excluded outright: a coordinator arriving before any
 * verb means the name is an item in a list, which is what "Kubernetes, Slack and Bedrock
 * are all down, can you check?" is.
 *
 * **The roster is consulted, not just the tags.** A name the transcriber lower-cased tags
 * as a common noun — "tom, do you know the port?" — and the yes-path in this file already
 * tolerates that for the agent's own name, because there it is matched against a known
 * string. Here the equivalent known strings are the people in the call, which the runtime
 * scrapes anyway. Without a roster the guard falls back to the tag alone, so it is weaker
 * early in a call than later.
 *
 * **A known limit.** The tagger calls a capitalised plural common noun a proper noun and
 * leaves its lemma alone, so "Dogs, do you have any thoughts" — a mis-transcription —
 * reads as a name here. Nothing local separates that from "Tom,", and it is the safe
 * direction anyway: the caller's only response is to stop skipping the model call.
 */
export function addressedToSomeoneElse(
  transcript: string,
  agentName: string,
  roster: readonly string[] = [],
): ThirdPartyRead {
  const text = transcript.trim();
  const self = agentName.trim().toLowerCase();
  if (text === '' || !readsScript(text)) return { read: false };
  if (tokenizer === undefined || tokenizer === null) return { read: false };

  let toks: Token[];
  try {
    toks = tokenizer(text);
  } catch {
    return { read: false };
  }

  const known = knownNames(roster, self);
  for (const sentence of splitSentences(toks)) {
    const name = vocativeIn(sentence, self, known);
    if (name !== null) return { read: true, name };
  }
  return { read: true, name: null };
}

/**
 * The room's names, lower-cased, with first names included and the agent removed.
 *
 * First names because that is what people say: the roster has "Mario Sarcher" and the
 * room says "Mario". The agent is dropped so its own name can never be read as a third
 * party, whichever spelling the roster holds it under.
 */
function knownNames(roster: readonly string[], self: string): Set<string> {
  const names = new Set<string>();
  for (const entry of roster) {
    for (const part of [entry, entry.trim().split(/\s+/)[0] ?? '']) {
      const name = part.trim().toLowerCase();
      if (name.length >= 2 && name !== self) names.add(name);
    }
  }
  return names;
}

/** Who this one sentence is addressed to, if it is addressed to somebody by name. */
function vocativeIn(sentence: Token[], self: string, known: Set<string>): string | null {
  const wordAt = sentence.map((t, i) => (isWord(t) ? i : -1)).filter((i) => i >= 0);
  if (wordAt.length === 0) return null;

  const nameLike = (i: number): boolean => {
    const token = sentence[i];
    const word = token.text.toLowerCase();
    if (word === self || NOT_A_NAME.test(word)) return false;
    // The roster outranks the tag: a lower-cased name tags as a common noun.
    if (known.has(word)) return true;
    if (nearAKnownName(word, known)) return true;
    // And with a roster in hand it is also the limit: a proper noun matching nobody in the
    // room is not somebody being spoken to.
    //
    // Two live calls, pulling opposite ways, are why it takes both halves. "Gotcha, thank you,
    // and does it support any spending limits?" was declined as a question for somebody called
    // Gotcha — the tagger calls it a proper noun and no grammatical test separates it from a
    // name, so only the roster can. And "Yari, do you know anything about that?" was answered
    // as a follow-up when it was plainly for Jari, whose name the transcriber had mangled — so
    // the roster has to tolerate a mishearing, or it trades one failure for the other.
    //
    // Only sound because the roster is read off the participants panel, so it is complete while
    // the panel is open. Two bounds worth stating: it is up to a poll interval stale, so a
    // brand-new joiner named aloud is not on it yet; and a name mangled past `NAME_EDITS`
    // ("Gary" for "Jari" is two edits at four letters) still misses. Both let the guard miss and
    // the agent answer something meant for a colleague — weighed against a false close, which
    // costs the person it *was* talking to their answer, and which is what live calls kept
    // producing.
    if (known.size > 0) return false;
    return token.pos === 'PROPN';
  };
  const commaAfter = (i: number) => sentence[i + 1]?.text === ',';
  const commaBefore = (i: number) => sentence[i - 1]?.text === ',';

  // A question mark, and nothing weaker. Without one, a name beside a comma is as likely to be
  // a date or a list item as somebody being spoken to — "Monday, we should ship" and "I'll do
  // it on Tuesday, Wednesday" both have a proper noun in vocative position and neither is
  // talking to anyone.
  //
  // It used to accept a second-person pronoun anywhere in the sentence, and that is what made
  // "Gotcha, thank you." read as a question for somebody called Gotcha: the tagger calls
  // `Gotcha` a proper noun, and `you` two words later was all the evidence the rule wanted. A
  // live call lost a plain request to the agent that way.
  //
  // An order to a third party is deliberately *not* also accepted here. It was tried: the
  // tagger reads "Jari, check the deploy." as `check/NOUN`, so there is no imperative to find,
  // and a base-form-verb rule found nothing while adding a mechanism. It needs none — the
  // follow-up window's own shape test closes on that sentence as a statement, which is the
  // same outcome by a route that already exists.
  const addressed = sentence.some((t) => t.text === '?');

  // 1 & 2. The first content word of the sentence, markers skipped.
  let head = 0;
  while (head < wordAt.length && !isCandidatePosition(sentence[wordAt[head]])) head += 1;
  if (head < wordAt.length) {
    const i = wordAt[head];
    if (nameLike(i) && !listedWith(sentence, wordAt, head)) {
      if (addressed && commaAfter(i)) return sentence[i].text;
      // No comma: "Pamela can you get the numbers?" — an inverted question whose subject
      // is the listener, which is the one shape people reliably say without a pause.
      const next = sentence[wordAt[head + 1] ?? -1];
      const after = sentence[wordAt[head + 2] ?? -1];
      if (
        next?.pos === 'AUX' &&
        after?.pos === 'PRON' &&
        SECOND_PERSON.test(after.text)
      ) {
        return sentence[i].text;
      }
    }
  }

  // 3. The last content word, fenced by a comma: "What do you think, Pamela?"
  const tail = wordAt[wordAt.length - 1];
  if (addressed && nameLike(tail) && commaBefore(tail)) return sentence[tail].text;

  // 4. Fenced anywhere, with second person close behind — and inside a question, like every
  // other position here. Without that last requirement this is the branch "Gotcha, thank you."
  // came through: a fenced proper noun with `you` behind it, and no question anywhere.
  for (const i of wordAt) {
    if (!addressed || !commaAfter(i) || !nameLike(i)) continue;
    const following = wordAt.filter((j) => j > i).slice(0, VOCATIVE_REACH_WORDS);
    if (following.some((j) => sentence[j].pos === 'PRON' && SECOND_PERSON.test(sentence[j].text))) {
      return sentence[i].text;
    }
  }

  return null;
}

/** A word that could be the head of a sentence rather than a marker in front of one. */
function isCandidatePosition(token: Token): boolean {
  return LEXICAL.has(token.pos) && !NOT_A_NAME.test(token.text);
}

/**
 * Is the name at `head` an item in a list rather than somebody being called?
 *
 * A coordinator arriving before any verb means the sentence is still naming things:
 * "Kubernetes, Slack and Bedrock are all down, can you check?" opens with a proper noun and
 * a comma exactly the way a vocative does. The same rule guards the yes-path in this file.
 */
function listedWith(sentence: Token[], wordAt: number[], head: number): boolean {
  for (const i of wordAt.slice(head + 1)) {
    const pos = sentence[i].pos;
    if (pos === 'VERB' || pos === 'AUX') return false;
    if (pos === 'CCONJ') return true;
  }
  return false;
}
