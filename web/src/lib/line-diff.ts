/**
 * The line difference between two versions of one identity document, computed
 * here rather than on the runtime: the documents are markdown a person reads,
 * and both sides are already in the browser.
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
  /** 1-based line number on the older side; absent on an added line. */
  oldLine?: number;
  /** 1-based line number on the newer side; absent on a removed line. */
  newLine?: number;
}

/**
 * How many changed lines one side may have before the difference degrades to
 * one removed block and one added block. The exact difference costs one table
 * cell per pair of changed lines, so the bound keeps a large document from
 * freezing the tab.
 */
export const MAX_DIFF_LINES = 5000;

/** Split a document into lines, dropping the empty line a trailing newline makes. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Every older line removed, then every newer line added. */
function wholeBlocks(older: string[], newer: string[], offset: number): DiffLine[] {
  return [
    ...older.map((text, i) => ({ kind: 'remove' as const, text, oldLine: offset + i + 1 })),
    ...newer.map((text, i) => ({ kind: 'add' as const, text, newLine: offset + i + 1 })),
  ];
}

/**
 * The exact difference over the changed middle, from the longest common
 * subsequence. The table holds lengths, which never exceed the shorter side, so
 * a 16-bit cell covers every input the bound admits.
 */
function lcsDiff(older: string[], newer: string[], offset: number): DiffLine[] {
  const rows = older.length;
  const cols = newer.length;
  const width = cols + 1;
  const table = new Uint16Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] =
        older[i] === newer[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (older[i] === newer[j]) {
      lines.push({ kind: 'same', text: older[i], oldLine: offset + i + 1, newLine: offset + j + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      lines.push({ kind: 'remove', text: older[i], oldLine: offset + i + 1 });
      i++;
    } else {
      lines.push({ kind: 'add', text: newer[j], newLine: offset + j + 1 });
      j++;
    }
  }
  while (i < rows) {
    lines.push({ kind: 'remove', text: older[i], oldLine: offset + i + 1 });
    i++;
  }
  while (j < cols) {
    lines.push({ kind: 'add', text: newer[j], newLine: offset + j + 1 });
    j++;
  }
  return lines;
}

/**
 * The difference between two documents, line by line and in reading order. The
 * shared head and tail are matched first, so an edit inside a long document
 * only costs the lines around it.
 */
export function diffLines(older: string, newer: string): DiffLine[] {
  const oldLines = splitLines(older);
  const newLines = splitLines(newer);

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < head; i++) {
    lines.push({ kind: 'same', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);
  const degrade = oldMiddle.length > MAX_DIFF_LINES || newMiddle.length > MAX_DIFF_LINES;
  lines.push(
    ...(degrade
      ? wholeBlocks(oldMiddle, newMiddle, head)
      : lcsDiff(oldMiddle, newMiddle, head)),
  );

  for (let i = 0; i < tail; i++) {
    const oldIndex = oldLines.length - tail + i;
    const newIndex = newLines.length - tail + i;
    lines.push({
      kind: 'same',
      text: oldLines[oldIndex],
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }
  return lines;
}
