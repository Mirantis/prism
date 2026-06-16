import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ResumeList } from './ResumeList.js';
import { ThreadSummary } from '../tui-adapter.js';

const MIN = 60_000;

function makeSessions(): ThreadSummary[] {
  return [
    {
      id: 'thread-alpha',
      updatedAt: new Date(Date.now() - 1.5 * MIN).toISOString(),
      workspaceRoot: '/home/me/.claude/worktrees/ability-to-cancel',
      branch: 'worktree/ability-to-cancel',
    },
    {
      id: 'thread-beta',
      updatedAt: new Date(Date.now() - 53.5 * MIN).toISOString(),
      workspaceRoot: '/home/me/dev/prism-agent',
      branch: null,
    },
  ];
}

// ink holds a lone trailing ESC for ~20ms before emitting it as a standalone
// Escape keypress; wait past that window, then let React commit.
const pressEscape = async (stdin: { write: (data: string) => void }) => {
  stdin.write('\x1b');
  await new Promise((r) => setTimeout(r, 60));
  await new Promise((r) => setImmediate(r));
};
const flush = () => new Promise((r) => setImmediate(r));

describe('ResumeList', () => {
  it('renders the header, cwd, ids, and time-ago + workspace labels', () => {
    const { lastFrame, unmount } = render(
      <ResumeList sessions={makeSessions()} cwd="/home/me/cwd" onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume session (1 of 2)');
    expect(frame).toContain('/home/me/cwd');
    expect(frame).toContain('thread-alpha');
    expect(frame).toContain('thread-beta');
    // basename + branch when both are known…
    expect(frame).toContain('1 minute ago · ability-to-cancel (worktree/ability-to-cancel)');
    // …basename only when there's no branch.
    expect(frame).toContain('53 minutes ago · prism-agent');
    // ❯ cursor sits on the first (selected) row.
    expect(frame).toContain('❯ thread-alpha');
    unmount();
  });

  it('moves the selection down with the arrow key', async () => {
    const { lastFrame, stdin, unmount } = render(
      <ResumeList sessions={makeSessions()} cwd="/cwd" onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    stdin.write('\x1B[B'); // Down
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume session (2 of 2)');
    expect(frame).toContain('❯ thread-beta');
    unmount();
  });

  it('calls onSelect with the highlighted id on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <ResumeList sessions={makeSessions()} cwd="/cwd" onSelect={onSelect} onCancel={vi.fn()} />,
    );
    stdin.write('\x1B[B'); // Down → select second
    await flush();
    stdin.write('\r'); // Enter
    await flush();
    expect(onSelect).toHaveBeenCalledWith('thread-beta');
    unmount();
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <ResumeList sessions={makeSessions()} cwd="/cwd" onSelect={vi.fn()} onCancel={onCancel} />,
    );
    await pressEscape(stdin);
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('shows at most 5 rows but reports the full total', () => {
    const many: ThreadSummary[] = Array.from({ length: 7 }, (_, i) => ({
      id: `thread-${i}`,
      updatedAt: new Date(Date.now() - (i + 1) * MIN).toISOString(),
      workspaceRoot: null,
      branch: null,
    }));
    const { lastFrame, unmount } = render(
      <ResumeList sessions={many} cwd="/cwd" onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume session (1 of 7)');
    // Window starts at the top: ids 0–4 visible, 5–6 scrolled off.
    for (let i = 0; i < 5; i++) expect(frame).toContain(`thread-${i}`);
    expect(frame).not.toContain('thread-5');
    expect(frame).not.toContain('thread-6');
    unmount();
  });
});
