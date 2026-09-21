/**
 * The filesystem calls sent to the engine, and how their output is read back.
 *
 * The engine is never run: a fake stands in for the `docker` client, so these
 * cases say the same thing on a machine with an engine and one without.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChild } from '../../../test-utils/fake-child';
import type { RunOptions } from '../execution-environment';

const launches: Array<{ command: string; args: readonly string[]; options: RunOptions }> = [];
let child: FakeChild;
let stdout: string | Buffer;
let exitCode = 0;
let stderr = '';

vi.mock('../local/local-process', () => ({
  runLocalProgram: (command: string, args: readonly string[], options: RunOptions) => {
    launches.push({ command, args, options });
    const proc = child.asExecProcess();
    process.nextTick(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.finish(exitCode);
    });
    return proc;
  },
}));

const { createDockerFiles, parseDirEntries, parseStat } = await import('./docker-files');

const files = () => createDockerFiles('agent-exec-test');

/** The script the shell was given, and the arguments after its `$0`. */
function callOf(index = 0) {
  const args = launches[index].args;
  const at = args.indexOf('-c');
  return { script: args[at + 1], argv0: args[at + 2], args: args.slice(at + 3) };
}

beforeEach(() => {
  launches.length = 0;
  child = new FakeChild();
  stdout = '';
  stderr = '';
  exitCode = 0;
});

describe('reading', () => {
  it('reads a whole file through the container', async () => {
    stdout = 'the contents';
    expect(await files().readText('/prism/workspace/a.txt')).toBe('the contents');

    const call = callOf();
    expect(launches[0].command).toBe('docker');
    expect(call.script).toBe('cat -- "$1"');
    // The path is an argument, never text in the script, so a name holding a
    // quote or a space cannot become part of the command.
    expect(call.args).toEqual(['/prism/workspace/a.txt']);
  });

  it('cuts a prefix in the container rather than over the pipe', async () => {
    stdout = 'fronm';
    await files().readText('/prism/skills/s/SKILL.md', { maxBytes: 5 });

    const call = callOf();
    expect(call.script).toBe('head -c "$2" -- "$1"');
    expect(call.args).toEqual(['/prism/skills/s/SKILL.md', '5']);
  });

  it('keeps bytes as bytes', async () => {
    stdout = Buffer.from([0x00, 0xff, 0x10]);
    expect([...(await files().readBytes('/prism/workspace/a.bin'))]).toEqual([0x00, 0xff, 0x10]);
  });
});

describe('writing', () => {
  it('sends the content on stdin, so no size goes through an argv', async () => {
    await files().writeText('/prism/workspace/a.txt', 'hello');

    const call = callOf();
    expect(call.script).toBe('cat > "$1"');
    expect(call.args).toEqual(['/prism/workspace/a.txt']);
    // `-i` is what connects our stdin to the container's.
    expect(launches[0].args).toContain('-i');
    expect(launches[0].options.stdin).toBe('pipe');
  });

  it('replaces a link and refuses to follow one to a directory', async () => {
    await files().symlink('/prism/skills', '/prism/claude/skills');
    expect(callOf().script).toBe('ln -sfn -- "$1" "$2"');
  });
});

describe('failures', () => {
  it('reports a missing path the way the local filesystem does', async () => {
    exitCode = 1;
    stderr = "cat: /prism/workspace/nope: No such file or directory\n";

    // A caller that branches on a missing file reads `err.code`.
    await expect(files().readText('/prism/workspace/nope')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('carries the engine\'s own words for anything else', async () => {
    exitCode = 1;
    stderr = 'rmdir: failed to remove: Directory not empty';
    await expect(files().removeDir('/prism/workspace/full')).rejects.toMatchObject({
      code: 'ENOTEMPTY',
      message: 'rmdir: failed to remove: Directory not empty',
    });
  });
});

describe('parsing what the container answered', () => {
  it('reads one stat line', () => {
    expect(parseStat(Buffer.from('4096 1758470400 directory\n'))).toEqual({
      size: 4096,
      mtimeMs: 1758470400000,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    });
    expect(parseStat(Buffer.from('12 1758470400 regular file'))).toMatchObject({
      isFile: true,
      isDirectory: false,
    });
    // `stat` spells an empty file out differently, and it is still a file.
    expect(parseStat(Buffer.from('0 1 regular empty file'))).toMatchObject({ isFile: true });
    expect(parseStat(Buffer.from('7 1 symbolic link'))).toMatchObject({
      isSymbolicLink: true,
      isFile: false,
    });
  });

  it('reads a directory listing, including a name with a newline in it', () => {
    const out = Buffer.from('f a.txt\0d nested\0l link\0f odd\nname\0');
    expect(parseDirEntries(out)).toEqual([
      { name: 'a.txt', isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: 'nested', isFile: false, isDirectory: true, isSymbolicLink: false },
      { name: 'link', isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: 'odd\nname', isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
  });

  it('reads an empty directory as empty', () => {
    expect(parseDirEntries(Buffer.from(''))).toEqual([]);
  });
});
