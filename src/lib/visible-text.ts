/** Whitespace and format characters such as a zero-width space, which a reader cannot see. */
const INVISIBLE_ONLY = /^[\s\p{Cf}]*$/u;

/**
 * The text trimmed, or empty when nothing in it is visible. A model told to end
 * with an empty reply can write a lone zero-width space, which `trim()` keeps.
 */
export function visibleText(text: string): string {
  return INVISIBLE_ONLY.test(text) ? '' : text.trim();
}
