import { describe, it, expect } from 'vitest';
import { applyEdit, applyEdits } from '../apply-edit';

describe('applyEdit', () => {
  it('replaces exact match', () => {
    const result = applyEdit('hello world', 'hello', 'goodbye');
    expect(result).toEqual({ success: true, content: 'goodbye world' });
  });

  it('rejects ambiguous match (multiple occurrences)', () => {
    const result = applyEdit('foo foo', 'foo', 'bar');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('2 matches');
    }
  });

  it('rejects identical old and new strings', () => {
    const result = applyEdit('hello', 'hello', 'hello');
    expect(result).toEqual({ success: false, error: 'oldText and newText are identical' });
  });

  it('falls back to line-trimmed matching', () => {
    const content = '  hello  \n  world  ';
    const result = applyEdit(content, 'hello\nworld', 'goodbye\nearth');
    expect(result).toEqual({ success: true, content: 'goodbye\nearth' });
  });

  it('rejects an ambiguous line-trimmed match instead of editing the first one', () => {
    // Two indented copies of the passage, neither an exact match for the
    // unindented search text.
    const content = '  - item\n  - other\n\n  - item\n  - other';
    const result = applyEdit(content, '- item\n- other', '- changed');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('2 whitespace-tolerant matches');
    }
  });

  it('returns error when nothing matches', () => {
    const result = applyEdit('hello world', 'missing', 'replacement');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });

  it('handles multiline exact match', () => {
    const content = '# Title\n\n## Section\nSome content\n\n## Other\nMore';
    const result = applyEdit(content, '## Section\nSome content', '## Section\nUpdated content');
    expect(result).toEqual({
      success: true,
      content: '# Title\n\n## Section\nUpdated content\n\n## Other\nMore',
    });
  });
});

describe('applyEdits', () => {
  it('applies multiple edits sequentially', () => {
    const content = '# Profile\nName: Alice\nRole: Engineer\nTimezone: UTC';
    const result = applyEdits(content, [
      { oldText: 'Name: Alice', newText: 'Name: Bob' },
      { oldText: 'Role: Engineer', newText: 'Role: SRE' },
      { oldText: 'Timezone: UTC', newText: 'Timezone: US/Pacific' },
    ]);
    expect(result).toEqual({
      success: true,
      content: '# Profile\nName: Bob\nRole: SRE\nTimezone: US/Pacific',
    });
  });

  it('stops on first failure and reports edit index', () => {
    const content = 'aaa\nbbb\nccc';
    const result = applyEdits(content, [
      { oldText: 'aaa', newText: 'AAA' },
      { oldText: 'MISSING', newText: 'xxx' },
      { oldText: 'ccc', newText: 'CCC' },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Edit 2/3 failed');
      expect(result.error).toContain('not found');
    }
  });

  it('returns original content unchanged for empty edits array', () => {
    const content = '# Unchanged\nContent here';
    const result = applyEdits(content, []);
    expect(result).toEqual({ success: true, content });
  });

  it('applies edits that depend on previous edits', () => {
    const content = 'hello world';
    const result = applyEdits(content, [
      { oldText: 'hello', newText: 'goodbye' },
      { oldText: 'goodbye world', newText: 'goodbye earth' },
    ]);
    expect(result).toEqual({ success: true, content: 'goodbye earth' });
  });
});
