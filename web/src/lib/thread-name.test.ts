import { describe, it, expect } from 'vitest';
import { threadDisplayName } from './thread-name';

describe('threadDisplayName', () => {
  it('prefers the thread title when set', () => {
    expect(
      threadDisplayName({
        title: 'keuruun saha translat...',
        workspaceRoot: '/Users/me/dev/project-two',
        createdAt: '2026-06-16T12:00:00Z',
      }),
    ).toBe('keuruun saha translat...');
  });

  it('falls back to the workspaceRoot basename when title is falsy', () => {
    expect(
      threadDisplayName({ title: null, workspaceRoot: '/Users/me/dev/project-two', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-two');
    expect(
      threadDisplayName({ title: '', workspaceRoot: '/Users/me/dev/project-two', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-two');
  });

  it('strips a trailing slash', () => {
    expect(
      threadDisplayName({ title: null, workspaceRoot: '/Users/me/dev/project-two/', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-two');
  });

  it('handles Windows-style separators', () => {
    expect(
      threadDisplayName({ title: null, workspaceRoot: 'C:\\Users\\me\\project-win', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-win');
  });

  it('falls back to a formatted creation date when title and workspaceRoot are both falsy', () => {
    const name = threadDisplayName({ title: null, workspaceRoot: null, createdAt: '2026-06-16T14:03:00Z' });
    expect(name).not.toBe('');
    // Locale-dependent exact text, but it must not look like a path.
    expect(name).not.toContain('/');
  });

  it('falls back when workspaceRoot is an empty string', () => {
    const name = threadDisplayName({ title: null, workspaceRoot: '', createdAt: '2026-06-16T14:03:00Z' });
    expect(name).not.toBe('');
  });
});
