/**
 * `format_file_content` ported from
 * `nexus-monorepo/crates/nexus-shell-sandbox/src/handlers/file_handlers.rs`.
 *
 * Returns the file with each line prefixed by its 1-indexed line
 * number, optionally sliced via offset/limit. Lines longer than
 * MAX_LINE_LENGTH are truncated with a marker — matches upstream.
 */

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

export function formatFileContent(
  raw: string,
  offset?: number,
  limit?: number,
): string {
  const lines = raw.split('\n');
  const startLine = Math.max(offset ?? 1, 1);
  const maxLines = limit ?? DEFAULT_READ_LIMIT;

  if (startLine > lines.length) {
    return `(file has ${lines.length} lines, offset ${startLine} is past end)`;
  }

  const sliceEnd = Math.min(startLine - 1 + maxLines, lines.length);
  const slice = lines.slice(startLine - 1, sliceEnd);
  const numbered = slice
    .map((line, i) => {
      const lineNum = startLine + i;
      const truncated =
        line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '... (truncated)' : line;
      return `${lineNum}: ${truncated}`;
    })
    .join('\n');

  const endLine = startLine - 1 + slice.length;
  const totalLines = lines.length;
  if (endLine < totalLines) {
    return `${numbered}\n(showing lines ${startLine}-${endLine} of ${totalLines}, use offset to read more)`;
  }
  return numbered;
}
