/**
 * Was that said *to the bot*?
 *
 * Only used in `addressedOnly` mode, which exists for meetings too large for the
 * model to answer every utterance in the room — both because it would be socially
 * wrong and because audio output is the expensive half of the Realtime bill.
 *
 * A cheap lexical test on purpose. The alternative — a classification LLM call per
 * utterance — adds latency to the one path that most needs to feel immediate, and
 * the failure modes here are mild in both directions: a missed mention means
 * someone repeats themselves with the bot's name, and a false positive means one
 * unnecessary reply. Turn detection itself stays with the Realtime API's semantic
 * VAD; this only decides who a finished utterance was aimed at.
 */

/** Words that make an utterance a request even without the bot's name attached. */
const DIRECT_ADDRESS_HINTS = [
  'are you there',
  'can you hear',
  'what do you think',
  'any thoughts',
  'over to you',
];

/**
 * True when `transcript` looks addressed to an agent named `agentName`.
 *
 * Matches on the name as a whole word (so "Prism" doesn't fire on "prismatic"),
 * plus a small set of phrases that only make sense as a direct address.
 */
export function isAddressedToAgent(transcript: string, agentName: string): boolean {
  const text = transcript.toLowerCase().trim();
  if (!text) return false;

  const name = agentName.toLowerCase().trim();
  if (name) {
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
