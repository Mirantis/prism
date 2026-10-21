/**
 * Wraps text from somebody other than the user in a tag, so a prompt can tell
 * the model which part of a message is data. Every opening and closing tag of
 * the fence, and of the enclosing tags `alsoStrip` names, is removed from the
 * text first, so the text can neither end its fence nor forge another one.
 */
export function fence(text: string, tag: string, alsoStrip: readonly string[] = []): string {
  let inner = text;
  for (const name of [tag, ...alsoStrip]) {
    inner = inner.replace(new RegExp(`</?\\s*${name}\\b[^>]*>`, 'gi'), '');
  }
  return `<${tag}>${inner}</${tag}>`;
}
