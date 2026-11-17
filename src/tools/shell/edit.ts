/**
 * `apply_edit` ported from the upstream Mirantis Agent Platform shell sandbox's file
 * handlers.
 *
 * Exact-match replacement with a whitespace-tolerant line-trimmed
 * fallback. Behavior mirrors upstream verbatim.
 */

export interface EditResult {
  ok: true;
  content: string;
}
export interface EditError {
  ok: false;
  message: string;
}

export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditResult | EditError {
  if (oldString === newString) {
    return { ok: false, message: 'oldString and newString are identical' };
  }

  // Exact match
  if (content.includes(oldString)) {
    if (replaceAll) {
      return { ok: true, content: content.split(oldString).join(newString) };
    }
    const matchCount = countOccurrences(content, oldString);
    if (matchCount > 1) {
      return {
        ok: false,
        message: `oldString has ${matchCount} matches — use replaceAll or provide more context to make it unique`,
      };
    }
    // replacen(1) — replace only the first occurrence
    const idx = content.indexOf(oldString);
    return {
      ok: true,
      content: content.slice(0, idx) + newString + content.slice(idx + oldString.length),
    };
  }

  // Line-trimmed match (whitespace-tolerant)
  const lineMatches = lineTrimmedMatches(content, oldString);
  if (lineMatches.length > 0) {
    if (replaceAll) {
      return {
        ok: false,
        message:
          'replaceAll requires exact match — the match was found via whitespace-tolerant search',
      };
    }
    // Ambiguity is an error on this path too, as it is for an exact match:
    // editing the first of several places is a silent wrong edit.
    if (lineMatches.length > 1) {
      return {
        ok: false,
        message: `oldString has ${lineMatches.length} whitespace-tolerant matches — provide more context to make it unique`,
      };
    }
    const [start, end] = lineMatches[0]!;
    return { ok: true, content: content.slice(0, start) + newString + content.slice(end) };
  }

  return { ok: false, message: 'oldString not found in file' };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Match `find` against `content` by trimming each line. Returns the
 * inclusive/exclusive byte range of the match in `content`, or `null`
 * if no match.
 */
/** Every place `find` matches `content` line by line after trimming each line. */
function lineTrimmedMatches(content: string, find: string): Array<[number, number]> {
  const contentLines = content.split('\n');
  const searchLines = find.split('\n');
  const found: Array<[number, number]> = [];

  // Upstream drops a trailing empty line from the search pattern so
  // `"b\nc\n"` matches two lines, not "two lines plus a blank".
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  if (searchLines.length > contentLines.length) return found;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      // Byte offsets. Each preceding line contributes (line.length + 1)
      // for the trailing newline.
      let start = 0;
      for (let k = 0; k < i; k++) start += contentLines[k].length + 1;
      const matched = contentLines.slice(i, i + searchLines.length);
      let matchedLen = 0;
      for (const line of matched) matchedLen += line.length;
      // newlines between matched lines (n-1 of them)
      const end = start + matchedLen + Math.max(0, matched.length - 1);
      found.push([start, end]);
    }
  }
  return found;
}
