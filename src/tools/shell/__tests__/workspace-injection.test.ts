/**
 * The per-thread workspace is injected at a single point: `getShellTools`
 * resolves it once via `resolveWorkspace` (the sole owner of the
 * thread-vs-global fallback) and hands the concrete path to every tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspace, resolveWorkspaceRoot } from '../config';
import { getShellTools } from '../index';

describe('resolveWorkspace (single fallback owner)', () => {
  const original = process.env.SHELL_WORKSPACE_ROOT;
  afterEach(() => {
    if (original === undefined) delete process.env.SHELL_WORKSPACE_ROOT;
    else process.env.SHELL_WORKSPACE_ROOT = original;
  });

  it('uses the given workspace root when it is a non-empty path', () => {
    expect(resolveWorkspace('/home/me/project')).toBe(path.resolve('/home/me/project'));
  });

  it('resolves the trimmed path, not the raw whitespace-padded string', () => {
    expect(resolveWorkspace('  /home/me/project  ')).toBe(path.resolve('/home/me/project'));
  });

  it('falls back to the global root when empty / whitespace / undefined', () => {
    process.env.SHELL_WORKSPACE_ROOT = '/global/ws';
    expect(resolveWorkspace('   ')).toBe(resolveWorkspaceRoot());
    expect(resolveWorkspace(undefined)).toBe(resolveWorkspaceRoot());
    expect(resolveWorkspace(null)).toBe(path.resolve('/global/ws'));
  });
});

describe('getShellTools workspace injection', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-inject-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('routes file tools to the injected workspace', async () => {
    const tools = getShellTools(workspace);

    // shell_write_file resolves its relative path against the injected workspace.
    const write = await tools.shell_write_file.execute!(
      { path: 'note.txt', content: 'hi there' },
      {} as never,
    );
    expect(write).toEqual({ ok: true });

    // The file landed under the injected workspace, not the global root.
    const onDisk = await fs.readFile(path.join(workspace, 'note.txt'), 'utf8');
    expect(onDisk).toBe('hi there');

    // shell_read_file reads back from the same workspace.
    const read = (await tools.shell_read_file.execute!(
      { path: 'note.txt' },
      {} as never,
    )) as { content: string };
    expect(read.content).toContain('hi there');
  });
});
