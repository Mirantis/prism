import { describe, it, expect } from 'vitest';
import { diffLines, MAX_DIFF_LINES, type DiffLine } from './line-diff';

/** The shape a reader sees: the marker and the text of each line. */
function shape(lines: DiffLine[]): string[] {
  const marker = { same: ' ', add: '+', remove: '-' };
  return lines.map((line) => `${marker[line.kind]}${line.text}`);
}

describe('diffLines', () => {
  it('marks every line of two equal documents as unchanged', () => {
    expect(shape(diffLines('# Soul\n\nBe direct.\n', '# Soul\n\nBe direct.\n'))).toEqual([
      ' # Soul',
      ' ',
      ' Be direct.',
    ]);
  });

  it('marks an inserted line as added and keeps the rest', () => {
    expect(shape(diffLines('a\nc\n', 'a\nb\nc\n'))).toEqual([' a', '+b', ' c']);
  });

  it('marks a deleted line as removed', () => {
    expect(shape(diffLines('a\nb\nc\n', 'a\nc\n'))).toEqual([' a', '-b', ' c']);
  });

  it('reports a changed line as a removal and an addition', () => {
    expect(shape(diffLines('a\nb\nc\n', 'a\nB\nc\n'))).toEqual([' a', '-b', '+B', ' c']);
  });

  it('numbers the lines on the side each one belongs to', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'b', oldLine: 2 },
      { kind: 'add', text: 'B', newLine: 2 },
      { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
    ]);
  });

  it('reports a cleared document as all removals, and a first draft as all additions', () => {
    expect(shape(diffLines('a\nb\n', ''))).toEqual(['-a', '-b']);
    expect(shape(diffLines('', 'a\nb\n'))).toEqual(['+a', '+b']);
  });

  it('reports a moved line once as removed and once as added', () => {
    expect(shape(diffLines('a\nb\nc\n', 'b\nc\na\n'))).toEqual(['-a', ' b', ' c', '+a']);
  });

  // The bound covers the middle, so a large document whose head and tail still
  // match is diffed line by line however long it is.
  it('degrades to one removed block and one added block past the bound', () => {
    const older = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `old ${i}`).join('\n');
    const newer = Array.from({ length: 2 }, (_, i) => `new ${i}`).join('\n');

    const lines = diffLines(older, newer);

    expect(lines.filter((line) => line.kind === 'remove')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(shape(lines).slice(-2)).toEqual(['+new 0', '+new 1']);
    expect(lines.some((line) => line.kind === 'same')).toBe(false);
  });
});
