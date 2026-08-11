/**
 * Was that said *to the agent*?
 *
 * The lexical half of `addressed` mode — `response-policy.ts` owns the decision
 * itself, including the sticky window that spares people repeating the name on
 * every follow-up.
 *
 * A cheap lexical test on purpose. The alternative — a classification LLM call per
 * utterance — adds latency to the one path that most needs to feel immediate, and
 * the failure modes here are mild in both directions: a missed mention means
 * someone repeats themselves with the agent's name, and a false positive means one
 * unnecessary reply. Turn detection itself stays with the Realtime API's semantic
 * VAD; this only decides who a finished utterance was aimed at.
 *
 * **Aliases rather than fuzzy matching.** Live transcription mangles names —
 * "Prism" comes back as "prisma", or as "prison". The fix is an explicit alias
 * list an operator adds once, not phonetics or edit distance: a metaphone match
 * catches "prisma" but not "prison" (PRSM vs PRSN), and a distance-2 match catches
 * "prison" along with a good deal else. An explainable list beats a fuzzy boundary
 * tuned by ear, especially here — every match becomes speech in a live room, and
 * the model has no way to decline once it has been asked to respond.
 */

/**
 * Phrases that are a direct address even without a name attached.
 *
 * Kept to presence checks, which are only ever aimed at the remote participant.
 * Deliberately *not* in this list: "what do you think", "any thoughts", "over to
 * you". Those are what people in a meeting say to each other, so they pulled the
 * agent into the middle of other people's conversations — the exact failure this
 * mode exists to prevent. The sticky window covers what they were reaching for.
 */
const DIRECT_ADDRESS_HINTS = ['are you there', 'can you hear'];

/**
 * True when `transcript` looks addressed to an agent named `agentName`.
 *
 * Matches the name — or any of `aliases` — as a whole word (so "Prism" doesn't
 * fire on "prismatic"), plus the presence-check phrases above.
 */
export function isAddressedToAgent(
  transcript: string,
  agentName: string,
  aliases: string[] = [],
): boolean {
  const text = transcript.toLowerCase().trim();
  if (!text) return false;

  for (const candidate of [agentName, ...aliases]) {
    const name = candidate?.toLowerCase().trim();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Lookarounds rather than `\b`: a `\b` anchor is defined against word
    // characters, so it silently fails to match a name that ends in punctuation
    // (`C++` followed by a space is two non-word characters, hence no boundary).
    // Asserting "not adjacent to a word character" holds for any name shape and
    // still keeps "prismatic" from summoning "Prism".
    if (new RegExp(`(?<!\\w)${escaped}(?!\\w)`).test(text)) return true;
  }

  return DIRECT_ADDRESS_HINTS.some((hint) => text.includes(hint));
}
