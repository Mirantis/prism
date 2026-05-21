/**
 * Targeted find-and-replace editing utility.
 *
 * Ported from nexus-shell-sandbox's sandbox-client.ts with simplification:
 * no `replaceAll` parameter — ambiguous matches always error.
 */

export interface EditOperation {
  oldText: string;
  newText: string;
}

export type EditResult =
  | { success: true; content: string }
  | { success: false; error: string };

/**
 * Apply a single find-and-replace edit to `content`.
 *
 * 1. Try exact match — if found exactly once, replace it.
 *    If found multiple times, return an error (ambiguous).
 * 2. Fall back to line-trimmed (whitespace-tolerant) matching.
 * 3. If nothing matches, return an error.
 */
export function applyEdit(content: string, oldText: string, newText: string): EditResult {
  if (oldText === newText) {
    return { success: false, error: 'oldText and newText are identical' };
  }

  // Try exact match first
  if (content.includes(oldText)) {
    const count = content.split(oldText).length - 1;
    if (count > 1) {
      return {
        success: false,
        error: `oldText has ${count} matches — provide more context to make it unique`,
      };
    }
    return { success: true, content: content.replace(oldText, newText) };
  }

  // Fall back to line-trimmed matching
  const match = lineTrimmedMatch(content, oldText);
  if (match) {
    return { success: true, content: content.slice(0, match.start) + newText + content.slice(match.end) };
  }

  return { success: false, error: 'oldText not found in content' };
}

/**
 * Apply an array of edits sequentially. Stops on first failure.
 */
export function applyEdits(content: string, edits: EditOperation[]): EditResult {
  let current = content;

  for (let i = 0; i < edits.length; i++) {
    const result = applyEdit(current, edits[i].oldText, edits[i].newText);
    if (!result.success) {
      return { success: false, error: `Edit ${i + 1}/${edits.length} failed: ${result.error}` };
    }
    current = result.content;
  }

  return { success: true, content: current };
}

function lineTrimmedMatch(content: string, find: string): { start: number; end: number } | null {
  const contentLines = content.split('\n');
  const searchLines = find.split('\n');

  // Remove trailing empty line from search (common when copying text)
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let start = 0;
      for (let k = 0; k < i; k++) {
        start += contentLines[k].length + 1;
      }
      let end = start;
      for (let k = 0; k < searchLines.length; k++) {
        end += contentLines[i + k].length;
        if (k < searchLines.length - 1) end += 1;
      }
      return { start, end };
    }
  }

  return null;
}
