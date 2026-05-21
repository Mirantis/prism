/**
 * `apply_edit` ported from
 * `nexus-monorepo/crates/nexus-shell-sandbox/src/handlers/file_handlers.rs`.
 *
 * Exact-match replacement with a whitespace-tolerant line-trimmed
 * fallback. Behavior mirrors upstream verbatim so the agent sees the
 * same semantics in single-agent and multi-tenant modes.
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
  const lineMatch = lineTrimmedMatch(content, oldString);
  if (lineMatch !== null) {
    if (replaceAll) {
      return {
        ok: false,
        message:
          'replaceAll requires exact match — the match was found via whitespace-tolerant search',
      };
    }
    const [start, end] = lineMatch;
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
function lineTrimmedMatch(content: string, find: string): [number, number] | null {
  const contentLines = content.split('\n');
  const searchLines = find.split('\n');

  // Upstream drops a trailing empty line from the search pattern so
  // `"b\nc\n"` matches two lines, not "two lines plus a blank".
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  if (searchLines.length > contentLines.length) return null;

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
      return [start, end];
    }
  }
  return null;
}
