import { describe, it, expect } from 'vitest';
import { threadDisplayName } from './thread-name';

describe('threadDisplayName', () => {
  it('uses the basename of a posix workspaceRoot', () => {
    expect(
      threadDisplayName({ workspaceRoot: '/Users/me/dev/project-two', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-two');
  });

  it('strips a trailing slash', () => {
    expect(
      threadDisplayName({ workspaceRoot: '/Users/me/dev/project-two/', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-two');
  });

  it('handles Windows-style separators', () => {
    expect(
      threadDisplayName({ workspaceRoot: 'C:\\Users\\me\\project-win', createdAt: '2026-06-16T12:00:00Z' }),
    ).toBe('project-win');
  });

  it('falls back to a formatted creation date when workspaceRoot is null', () => {
    const name = threadDisplayName({ workspaceRoot: null, createdAt: '2026-06-16T14:03:00Z' });
    expect(name).not.toBe('');
    // Locale-dependent exact text, but it must not look like a path.
    expect(name).not.toContain('/');
  });

  it('falls back when workspaceRoot is an empty string', () => {
    const name = threadDisplayName({ workspaceRoot: '', createdAt: '2026-06-16T14:03:00Z' });
    expect(name).not.toBe('');
  });
});
