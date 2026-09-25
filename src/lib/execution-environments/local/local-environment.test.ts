/**
 * The local environment against real processes and a real temp directory — no
 * mocks, the same style as the shell tools' own tests. What is proved here is
 * the contract every implementation has to keep: when `ended` settles versus
 * `closed`, that a group kill reaches a grandchild, and what each file
 * operation reports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLocalEnvironment } from './local-environment';

const environment = createLocalEnvironment();
let dir: string;

beforeEach(() => {
  // realpath, so macOS's /var → /private/var symlink doesn't make a path
  // comparison fail for reasons that have nothing to do with the test.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-env-')));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(command: string) {
  return environment.runShell(command, {
    cwd: dir,
    env: environment.baseEnv(),
    stdin: 'ignore',
  });
}

describe('the local environment', () => {
  it('identifies itself', () => {
    expect(environment.id).toBe('local');
    expect(environment.displayName).toBe('local');
  });
});

describe('local processes', () => {
  it('reports the exit code and the output a command produced', async () => {
    const proc = run('echo out; echo err >&2; exit 3');
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    const end = await proc.closed;
    expect(end.exitCode).toBe(3);
    expect(end.error).toBeNull();
    expect(Buffer.concat(chunks).toString()).toBe('out\n');
  });

  it('runs in the given directory', async () => {
    const proc = run('pwd');
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    await proc.closed;
    expect(Buffer.concat(chunks).toString().trim()).toBe(dir);
  });

  it('reports a launch failure rather than throwing', async () => {
    const proc = environment.runProgram('definitely-not-a-binary-x9', [], {
      cwd: dir,
      env: environment.baseEnv(),
      stdin: 'ignore',
    });
    const end = await proc.ended;
    expect(end.error).toBeInstanceOf(Error);
    expect(end.exitCode).toBeNull();
  });

  it('ends before it closes when a grandchild still holds the pipes', async () => {
    // The shell exits at once; the background child keeps stdout open. Exit
    // accounting reads `ended` precisely so it does not wait for that child.
    const proc = run('sleep 0.4 & exit 0');
    const first = await Promise.race([
      proc.ended.then(() => 'ended' as const),
      proc.closed.then(() => 'closed' as const),
    ]);
    expect(first).toBe('ended');
    await proc.closed;
  });

  it('kills the whole group, so a grandchild cannot outlive the kill', async () => {
    // Without the group kill this never closes: the shell is already gone and
    // its child holds the pipes for the next 30 seconds.
    const proc = run('sleep 30 & exit 0');
    await proc.ended;
    expect(proc.kill('SIGKILL')).toBe(true);
    await expect(proc.closed).resolves.toMatchObject({ exitCode: 0 });
  });

  it('writes to a process that asked for stdin', async () => {
    const proc = environment.runShell('cat', {
      cwd: dir,
      env: environment.baseEnv(),
      stdin: 'pipe',
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    proc.stdin?.end('hello\n');
    await proc.closed;
    expect(Buffer.concat(chunks).toString()).toBe('hello\n');
  });
});

describe('local files', () => {
  const files = environment.files;

  it('writes and reads text', async () => {
    const file = path.join(dir, 'a.txt');
    await files.writeText(file, 'hello');
    expect(await files.readText(file)).toBe('hello');
  });

  it('reads only the requested prefix', async () => {
    const file = path.join(dir, 'head.txt');
    await files.writeText(file, 'abcdefghij');
    expect(await files.readText(file, { maxBytes: 4 })).toBe('abcd');
  });

  it('writes and reads bytes', async () => {
    const file = path.join(dir, 'a.bin');
    await files.writeBytes(file, Buffer.from([0, 1, 2, 255]));
    expect([...(await files.readBytes(file))]).toEqual([0, 1, 2, 255]);
  });

  it('creates parent directories', async () => {
    const nested = path.join(dir, 'x', 'y');
    await files.mkdir(nested);
    expect((await files.stat(nested)).isDirectory).toBe(true);
  });

  it('renames a file', async () => {
    const from = path.join(dir, 'from');
    const to = path.join(dir, 'to');
    await files.writeText(from, 'moved');
    await files.rename(from, to);
    expect(await files.readText(to)).toBe('moved');
    await expect(files.stat(from)).rejects.toThrow();
  });

  it('reports size, kind and modification time', async () => {
    const file = path.join(dir, 'stat.txt');
    await files.writeText(file, 'abc');
    const stat = await files.stat(file);
    expect(stat.size).toBe(3);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('follows a symlink on stat and reports it on lstat', async () => {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    await files.writeText(target, 'x');
    fs.symlinkSync(target, link);
    expect((await files.stat(link)).isSymbolicLink).toBe(false);
    expect((await files.lstat(link)).isSymbolicLink).toBe(true);
  });

  it('lists a directory with the kind of each entry', async () => {
    await files.mkdir(path.join(dir, 'sub'));
    await files.writeText(path.join(dir, 'file'), 'x');
    const entries = (await files.readDir(dir)).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: 'file', isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: 'sub', isFile: false, isDirectory: true, isSymbolicLink: false },
    ]);
  });

  it('removes a tree, and a path that is already gone', async () => {
    const tree = path.join(dir, 'tree', 'deep');
    await files.mkdir(tree);
    await files.writeText(path.join(tree, 'f'), 'x');
    await files.remove(path.join(dir, 'tree'));
    await expect(files.stat(path.join(dir, 'tree'))).rejects.toThrow();
    await expect(files.remove(path.join(dir, 'tree'))).resolves.toBeUndefined();
  });

  it('removes an empty directory and refuses a populated one', async () => {
    const empty = path.join(dir, 'empty');
    const full = path.join(dir, 'full');
    await files.mkdir(empty);
    await files.mkdir(full);
    await files.writeText(path.join(full, 'f'), 'x');
    await expect(files.removeDir(empty)).resolves.toBeUndefined();
    await expect(files.removeDir(full)).rejects.toThrow();
  });

  it('throws on a file that is not there', async () => {
    await expect(files.readText(path.join(dir, 'nope'))).rejects.toThrow();
  });
});
