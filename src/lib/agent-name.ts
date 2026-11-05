/**
 * The rule for a name the agent gives itself.
 *
 * The name is sent to other agents' prompts, people's notifications and the
 * systems that show it, and the agent can be talked into renaming itself, so
 * a name has only what a name needs and nothing that could hold an
 * instruction or markup: letters of any script with their marks, digits,
 * single spaces, and `- ' ’ . &`. No emoji, symbols, quotes, brackets, colons,
 * slashes, `@` or line breaks. A host that copies the name elsewhere can hold
 * it to the same rule and accept every name this module accepts.
 */

/** The longest name, in UTF-16 code units. */
export const AGENT_NAME_MAX = 64;

/** What a refused name is told: the agent reads it from `rename_self` and can pick another. */
export const AGENT_NAME_RULE = "Use a name of up to 64 characters, with letters, digits and spaces. It may also contain - ' . and &.";

/** Combining marks in a row after a letter: enough for any script's letters, too few to stack text over a line. */
const MAX_MARKS_IN_A_ROW = 3;

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{Nd}$/u;
const PUNCTUATION = new Set(['-', "'", '’', '.', '&']);

/**
 * The name, normalised to NFC, trimmed, with runs of spaces made one; or
 * undefined when it breaks the rule. An empty name is undefined too.
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
