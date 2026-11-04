/**
 * The tags of the memory blocks a chat turn sends after the user's message, and
 * stores as hidden USER rows so a replayed thread rebuilds the same prompt.
 */

export const RECALLED_TAG = 'recalled-memories';
export const RECENT_TAG = 'recent-memories';

export function memoryBlockOpening(tag: string): string {
  return `\n\nContext:\n<${tag}>\n`;
}

/** Whether `text` is one of those blocks rather than something a person wrote. */
export function isMemoryBlockContent(text: string): boolean {
  return text.startsWith(memoryBlockOpening(RECALLED_TAG)) || text.startsWith(memoryBlockOpening(RECENT_TAG));
}
