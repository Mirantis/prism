/**
 * Behavior tests for the shell tool handlers (`runShellExec`,
 * `runReadFile`, `runWriteFile`, `runEditFile`). Uses a real temp
 * directory as the workspace so we exercise the full path
 * resolution + fs I/O. The MCP registration layer is a thin
 * wrapper, so we skip re-testing it here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runShellExec, shellExecInput } from '../exec';
import { MAX_EXEC_OUTPUT_BYTES } from '../config';
import { runReadFile, runWriteFile, runEditFile } from '../files';

let workspace: string;

beforeAll(async () => {
  // Resolve any symlinks (on macOS /tmp -> /private/tmp) so `pwd` inside
  // the spawned shell matches what we hand to runShellExec.
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'shell-tools-test-')),
  );
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('shell_exec (runShellExec)', () => {
  it('captures stdout and exit code on success', async () => {
    const result = await runShellExec({ command: "echo hello" }, workspace);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
  });

  it('surfaces non-zero exits with stderr', async () => {
    const result = await runShellExec(
      { command: "echo oops >&2; exit 3" },
      workspace,
    );
    expect(result.stderr.trim()).toBe('oops');
    expect(result.exitCode).toBe(3);
  });

  it('runs in the workspace by default and honors a workdir override', async () => {
    const sub = path.join(workspace, 'sub');
    await fs.mkdir(sub, { recursive: true });
    const defaultCwd = await runShellExec({ command: 'pwd' }, workspace);
    expect(defaultCwd.stdout.trim()).toBe(workspace);
    const subCwd = await runShellExec({ command: 'pwd', workdir: 'sub' }, workspace);
    expect(subCwd.stdout.trim()).toBe(sub);
  });

  it('times out and sets timedOut when the command exceeds the budget', async () => {
    const result = await runShellExec(
      { command: 'sleep 5', timeout: 200 },
      workspace,
    );
    expect(result.timedOut).toBe(true);
    // SIGTERM → exit code 143 (128 + 15) on most shells
    expect(result.exitCode).not.toBe(0);
  });

  it('kills the child and sets aborted when the turn is canceled mid-command', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = runShellExec({ command: 'sleep 5' }, workspace, controller.signal);
    // Let the child start, then cancel the turn.
    setTimeout(() => controller.abort(), 150);
    const result = await p;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // Killed promptly — nowhere near the 5s the command would have taken.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('does not run a command when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await runShellExec({ command: 'sleep 5' }, workspace, controller.signal);
    expect(result.aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('truncates stdout at the default 10000-byte limit and appends a marker', async () => {
    const result = await runShellExec(
      { command: "head -c 20000 /dev/zero | tr '\\0' 'x'" },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^x{10000}\n\.\.\. \(truncated; exceeded 10000 bytes\)$/);
  });

  it('honors a custom limit and reports it in the marker', async () => {
    const result = await runShellExec(
      { command: "head -c 5000 /dev/zero | tr '\\0' 'x'", limit: 100 },
      workspace,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^x{100}\n\.\.\. \(truncated; exceeded 100 bytes\)$/);
  });

  it('omits the truncation marker when output fits under the limit', async () => {
    const result = await runShellExec(
      { command: 'echo hi', limit: 1000 },
      workspace,
    );
    expect(result.stdout).toBe('hi\n');
    expect(result.stdout).not.toContain('(truncated;');
    expect(result.stderr).not.toContain('(truncated;');
  });

  it('applies the limit independently to stdout and stderr', async () => {
    const cmd =
      "head -c 500 /dev/zero | tr '\\0' 'a'; head -c 500 /dev/zero | tr '\\0' 'b' >&2";
    const result = await runShellExec({ command: cmd, limit: 300 }, workspace);
    expect(result.stdout).toMatch(/^a{300}\n\.\.\. \(truncated; exceeded 300 bytes\)$/);
    expect(result.stderr).toMatch(/^b{300}\n\.\.\. \(truncated; exceeded 300 bytes\)$/);
  });

  it('schema rejects a limit above MAX_EXEC_OUTPUT_BYTES', () => {
    const parsed = shellExecInput.safeParse({
      command: 'echo hi',
      limit: MAX_EXEC_OUTPUT_BYTES + 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects a limit below 1', () => {
    const parsed = shellExecInput.safeParse({ command: 'echo hi', limit: 0 });
    expect(parsed.success).toBe(false);
  });
});

describe('shell file tools', () => {
  it('rejects relative paths that escape the workspace', async () => {
    const read = await runReadFile({ path: '../etc/passwd' }, workspace);
    expect(read).toEqual({ error: 'Path outside workspace' });
    const write = await runWriteFile(
      { path: '../escape.txt', content: 'nope' },
      workspace,
    );
    expect(write).toEqual({ error: 'Path outside workspace' });
  });

  it('write → read roundtrips, and creates parent directories', async () => {
    const write = await runWriteFile(
      { path: 'nested/sub/file.txt', content: 'line1\nline2\n' },
      workspace,
    );
    expect(write).toEqual({ ok: true });

    const read = await runReadFile({ path: 'nested/sub/file.txt' }, workspace);
    expect('content' in read).toBe(true);
    if ('content' in read) {
      expect(read.content).toContain('1: line1');
      expect(read.content).toContain('2: line2');
    }
  });

  it('edit applies exact-match replacement', async () => {
    await runWriteFile(
      { path: 'edit.txt', content: 'hello world' },
      workspace,
    );
    const edit = await runEditFile(
      { path: 'edit.txt', old_string: 'hello', new_string: 'goodbye' },
      workspace,
    );
    expect(edit).toEqual({ ok: true });
    const buf = await fs.readFile(path.join(workspace, 'edit.txt'), 'utf8');
    expect(buf).toBe('goodbye world');
  });

  it('edit fails when old_string matches multiple times without replace_all', async () => {
    await runWriteFile(
      { path: 'multi.txt', content: 'aa bb aa' },
      workspace,
    );
    const edit = await runEditFile(
      { path: 'multi.txt', old_string: 'aa', new_string: 'cc' },
      workspace,
    );
    expect('error' in edit).toBe(true);
    if ('error' in edit) expect(edit.error).toMatch(/2 matches/);
  });

  it('edit replaces all occurrences when replace_all is true', async () => {
    await runWriteFile(
      { path: 'multi2.txt', content: 'aa bb aa' },
      workspace,
    );
    const edit = await runEditFile(
      {
        path: 'multi2.txt',
        old_string: 'aa',
        new_string: 'cc',
        replace_all: true,
      },
      workspace,
    );
    expect(edit).toEqual({ ok: true });
    const buf = await fs.readFile(path.join(workspace, 'multi2.txt'), 'utf8');
    expect(buf).toBe('cc bb cc');
  });

  it('read returns an ENOENT-shaped error for missing files', async () => {
    const result = await runReadFile({ path: 'does-not-exist.txt' }, workspace);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/ENOENT|no such file/i);
  });
});
