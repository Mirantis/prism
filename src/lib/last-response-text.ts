/** The final written response can precede an empty step after a tool result. */
export function lastResponseText(steps: ReadonlyArray<{ text: string }>): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = steps[i].text.trim();
    if (text) return text;
  }
  return '';
}
