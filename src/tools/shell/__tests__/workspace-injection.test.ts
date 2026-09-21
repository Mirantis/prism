/**
 * The per-thread workspace is injected at a single point: `getShellTools`
 * resolves it once via `resolveWorkspace` (the sole owner of the
 * thread-vs-global fallback) and hands the concrete path to every tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspace } from '../../../lib/execution-environments/workspace';
import { getExecutionEnvironment } from '../../../lib/execution-environments/get-execution-environment';
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
    expect(resolveWorkspace('   ')).toBe(getExecutionEnvironment().workspaceRoot());
    expect(resolveWorkspace(undefined)).toBe(getExecutionEnvironment().workspaceRoot());
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

/**
 * The write tools announce the file they are about to write before any tool in
 * the step runs, so a reader in the same step can wait for them. Registration is
 * by *resolved* path, because that is the only form both halves of
 * write-then-share can agree on.
 */
describe('getShellTools write announcements', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-announce-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const makeRegistry = () => {
    const registered: Array<{ id: string; tool: string; path: string }> = [];
    const settled: string[] = [];
    return {
      registered,
      settled,
      registry: {
        register: (id: string | undefined, tool: string, fullPath: string) =>
          registered.push({ id: id!, tool, path: fullPath }),
        settle: (id: string | undefined) => settled.push(id!),
        announce: () => undefined,
        wasAnnounced: () => true,
        waitFor: async () => ({ status: 'none' as const }),
        clear: () => undefined,
      },
    };
  };

  for (const [name, input] of [
    ['shell_write_file', { path: 'notes/draft.md', content: 'hello\n' }],
    ['shell_edit_file', { path: 'notes/draft.md', old_string: 'hello', new_string: 'hi' }],
  ] as const) {
    it(`${name} announces the resolved path and settles when it returns`, async () => {
      const { registered, settled, registry } = makeRegistry();
      const tools = getShellTools(workspace, registry);
      const tool = tools[name] as never as {
        onInputAvailable: (o: { input: unknown; toolCallId: string }) => void;
        execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
      };

      tool.onInputAvailable({ input, toolCallId: 'call-1' });
      expect(registered).toEqual([
        { id: 'call-1', tool: name, path: path.join(workspace, 'notes/draft.md') },
      ]);

      // Settles even for shell_edit_file here, which fails: the file does not
      // exist. A failed write must not strand a reader for the whole timeout.
      await tool.execute(input, { toolCallId: 'call-1' });
      expect(settled).toEqual(['call-1']);
    });
  }

  it('resolves an absolute path to the same string a relative one produces', () => {
    const { registered, registry } = makeRegistry();
    const tools = getShellTools(workspace, registry);
    const tool = tools.shell_write_file as never as {
      onInputAvailable: (o: { input: unknown; toolCallId: string }) => void;
    };

    tool.onInputAvailable({ input: { path: 'draft.md', content: 'x' }, toolCallId: 'a' });
    tool.onInputAvailable({
      input: { path: path.join(workspace, 'draft.md'), content: 'x' },
      toolCallId: 'b',
    });

    expect(registered[0].path).toBe(registered[1].path);
  });

  it('writes normally when no registry is supplied', async () => {
    const tools = getShellTools(workspace);
    const tool = tools.shell_write_file as never as {
      execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown>;
    };
    await tool.execute({ path: 'plain.txt', content: 'ok\n' }, { toolCallId: 'call-1' });
    await expect(fs.readFile(path.join(workspace, 'plain.txt'), 'utf8')).resolves.toBe('ok\n');
  });
});
