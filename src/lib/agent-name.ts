/**
 * The rule for a name the agent gives itself.
 *
 * The name is sent to other agents' prompts, people's notifications and the
 * systems that show it, and the agent can be talked into renaming itself. The
 * rule limits which characters a name may have: letters of any script with
 * their marks, digits, single spaces, and `- ' ’ . &`. That keeps markup, line
 * breaks, quotes, role markers such as `System:`, emoji and invisible
 * characters out of every place the name goes. A name of permitted characters
 * passes whatever it says ("Ignore previous instructions" is letters and
 * spaces), so every place that shows a name shows it as data.
 *
 * Invisible characters are refused even where a script uses them: Unicode's
 * default-ignorable characters, such as the zero-width non-joiner some
 * Persian words take, a Hangul filler that counts as a letter, or a variation
 * selector that counts as a mark. A name that needs one is written without
 * it.
 */

/** The longest name, in UTF-16 code units. */
export const AGENT_NAME_MAX = 64;

/** What a refused name is told: the agent reads it from `rename_self` and can pick another. */
export const AGENT_NAME_RULE = `Use a name of up to ${AGENT_NAME_MAX} characters, with letters, digits and spaces. It may also contain - ' . and &.`;

/** Combining marks in a row after a letter: enough for any script's letters, too few to stack text over a line. */
const MAX_MARKS_IN_A_ROW = 3;

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{Nd}$/u;
const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;
const PUNCTUATION = new Set(['-', "'", '\u2019', '.', '&']);

/**
 * The name, normalised to NFC, trimmed, with runs of spaces made one; or
 * undefined when it breaks the rule. An empty name breaks it.
 */
export function normaliseAgentName(name: string): string | undefined {
  const value = name.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  if (value.length === 0 || value.length > AGENT_NAME_MAX || !followsRule(value)) return undefined;
  return value;
}

function followsRule(value: string): boolean {
  let marks = 0;
  let afterLetter = false;
  let hasLetterOrDigit = false;
  for (const char of value) {
    if (INVISIBLE.test(char)) return false;
    if (LETTER.test(char)) {
      hasLetterOrDigit = true;
      afterLetter = true;
      marks = 0;
    } else if (MARK.test(char)) {
      // A mark belongs to the letter before it, and only a few may stack.
      if (!afterLetter || ++marks > MAX_MARKS_IN_A_ROW) return false;
    } else if (DIGIT.test(char)) {
      hasLetterOrDigit = true;
      afterLetter = false;
      marks = 0;
    } else if (char === ' ' || PUNCTUATION.has(char)) {
      afterLetter = false;
      marks = 0;
    } else {
      return false;
    }
  }
  return hasLetterOrDigit;
}
