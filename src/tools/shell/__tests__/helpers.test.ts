/**
 * Port of the Rust unit tests from the upstream Lens Agents shell sandbox's
 * workspace and file handlers.
 * Kept deliberately close in structure to the upstream tests so
 * regressions can be diffed across languages.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolvePath, isInsideWorkspace } from '../workspace';
import { applyEdit } from '../edit';
import { formatFileContent } from '../format';
import { appendCappedChunk } from '../exec';

describe('workspace.resolvePath', () => {
  it('resolves relative paths from the workspace root', () => {
    expect(resolvePath('/home/sandbox', 'src/main.rs')).toBe(
      path.join('/home/sandbox', 'src/main.rs'),
    );
  });

  it('passes absolute paths through as-is', () => {
    expect(resolvePath('/home/sandbox', '/src/main.rs')).toBe('/src/main.rs');
    expect(resolvePath('/home/sandbox', '/tmp')).toBe('/tmp');
    expect(resolvePath('/home/sandbox', '/tmp/workdir')).toBe('/tmp/workdir');
  });

  it('normalizes ../ in relative paths', () => {
    expect(resolvePath('/home/sandbox', '../../etc/passwd')).toBe('/etc/passwd');
  });

  it('collapses double-slashes in absolute paths', () => {
    expect(resolvePath('/home/sandbox', '//etc/passwd')).toBe('/etc/passwd');
  });
});

describe('workspace.isInsideWorkspace', () => {
  it('accepts paths under the workspace', () => {
    expect(isInsideWorkspace('/home/sandbox/file.txt', '/home/sandbox')).toBe(true);
    expect(isInsideWorkspace('/home/sandbox', '/home/sandbox')).toBe(true);
  });

  it('rejects paths outside the workspace', () => {
    expect(isInsideWorkspace('/etc/passwd', '/home/sandbox')).toBe(false);
    // Prefix-match must not cross the directory boundary.
    expect(isInsideWorkspace('/home/sandboxer', '/home/sandbox')).toBe(false);
  });

  it('rejects ../ traversal through the workspace root', () => {
    expect(isInsideWorkspace('/home/sandbox/../../etc/passwd', '/home/sandbox')).toBe(false);
  });
});

describe('edit.applyEdit', () => {
  it('replaces a single occurrence exactly', () => {
    const result = applyEdit('hello world', 'hello', 'goodbye', false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('goodbye world');
  });

  it('replaces all occurrences when replaceAll is true', () => {
    const result = applyEdit('aa bb aa', 'aa', 'cc', true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('cc bb cc');
  });

  it('rejects multiple matches when replaceAll is false', () => {
    const result = applyEdit('aa bb aa', 'aa', 'cc', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/2 matches/);
  });

  it('rejects identical old and new strings', () => {
    const result = applyEdit('hello', 'hello', 'hello', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/identical/);
  });

  it('errors when oldString is not present', () => {
    const result = applyEdit('hello', 'xyz', 'abc', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not found/);
  });

  it('falls back to line-trimmed match when exact match fails', () => {
    const content = '  function foo() {\n    return 1;\n  }';
    const result = applyEdit(
      content,
      'function foo() {\nreturn 1;\n}',
      'function bar() {\nreturn 2;\n}',
      false,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain('function bar()');
  });

  it('keeps the exact-match path when both exact and trimmed would match', () => {
    // If exact match hits first the line-trimmed branch isn't even tried.
    const result = applyEdit('  hello\n', 'hello', 'goodbye', true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('  goodbye\n');
  });
});

describe('exec.appendCappedChunk', () => {
  const fresh = () => ({
    chunks: [] as Buffer[],
    countRef: { n: 0 },
    truncRef: { t: false },
  });

  it('appends within the cap and updates the count', () => {
    const s = fresh();
    appendCappedChunk(Buffer.from('hello'), s.chunks, s.countRef, s.truncRef, 100);
    expect(s.countRef.n).toBe(5);
    expect(s.truncRef.t).toBe(false);
    expect(Buffer.concat(s.chunks, s.countRef.n).toString()).toBe('hello');
  });

  it('keeps the partial chunk at the cap boundary AND counts it', () => {
    const s = fresh();
    appendCappedChunk(Buffer.from('aaaa'), s.chunks, s.countRef, s.truncRef, 10);
    appendCappedChunk(Buffer.from('bbbbbbbb'), s.chunks, s.countRef, s.truncRef, 10);
    // Cap is 10. First chunk ate 4, partial of second chunk fills 6 more.
    expect(s.countRef.n).toBe(10);
    expect(s.truncRef.t).toBe(true);
    // Critical: Buffer.concat with the running count must yield the full
    // capped output (10 bytes), not 4. Without the count update on the
    // partial chunk, this returned 4 bytes.
    expect(Buffer.concat(s.chunks, s.countRef.n).toString()).toBe('aaaabbbbbb');
  });

  it('drops further chunks once truncated', () => {
    const s = fresh();
    appendCappedChunk(Buffer.from('aaaaaaaaaaaa'), s.chunks, s.countRef, s.truncRef, 5);
    expect(s.countRef.n).toBe(5);
    expect(s.truncRef.t).toBe(true);
    appendCappedChunk(Buffer.from('xxx'), s.chunks, s.countRef, s.truncRef, 5);
    expect(s.countRef.n).toBe(5); // still 5
    expect(Buffer.concat(s.chunks, s.countRef.n).toString()).toBe('aaaaa');
  });

  it('handles a chunk that exactly equals the remaining capacity', () => {
    const s = fresh();
    appendCappedChunk(Buffer.from('hello'), s.chunks, s.countRef, s.truncRef, 5);
    expect(s.countRef.n).toBe(5);
    expect(s.truncRef.t).toBe(false);
  });
});

describe('format.formatFileContent', () => {
  it('numbers every line starting at 1', () => {
    const result = formatFileContent('line1\nline2\nline3\n');
    expect(result).toContain('1: line1');
    expect(result).toContain('2: line2');
    expect(result).toContain('3: line3');
  });

  it('respects offset and limit', () => {
    const result = formatFileContent('a\nb\nc\nd\ne\n', 3, 2);
    expect(result.startsWith('3: c')).toBe(true);
    expect(result).toContain('4: d');
    expect(result).toContain('(showing lines 3-4 of 6');
  });

  it('reports past-end when offset exceeds file length', () => {
    const result = formatFileContent('a\nb\n', 100);
    expect(result).toContain('past end');
  });

  it('truncates lines longer than MAX_LINE_LENGTH', () => {
    const raw = 'x'.repeat(3000);
    const result = formatFileContent(raw);
    expect(result).toContain('... (truncated)');
  });
});
