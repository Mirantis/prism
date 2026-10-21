/**
 * Wraps text from somebody other than the user in a tag, so a prompt can tell
 * the model which part of a message is data. `<` and `>` in the text are
 * escaped, so no tag can form inside it: the text can neither end its fence
 * nor open another.
 */
export function fence(text: string, tag: string): string {
  return `<${tag}>${escapeAngles(text)}</${tag}>`;
}

/** `text` with `<` and `>` written as `&lt;` and `&gt;`. */
export function escapeAngles(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
