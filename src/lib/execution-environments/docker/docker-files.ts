/**
 * The container's filesystem, reached from the host.
 *
 * The agent's files live in named volumes, so this process cannot open them
 * and every operation is one `docker exec`. That is a process launch per call,
 * which is affordable because none of these paths is hot: the skill and plugin
 * catalogs are cached on a directory's mtime, an oversized tool result is one
 * write, and an attachment is a handful of calls. A resident helper speaking a
 * protocol would be faster and is not worth its lifecycle yet.
 *
 * A path is always a positional argument, never text inside the script, so a
 * name holding a quote or a space cannot become part of the command. Output is
 * collected as bytes and decoded only where the contract asks for text.
 */
import { logger } from '../../../logger';
import type { DirEntry, ExecutionFiles, FileStat } from '../execution-environment';
import { runLocalProgram } from '../local/local-process';
import { reportIfContainerLost } from './container-lost';
import { DOCKER } from './engine';

/** Long enough for a large file over the engine's pipe, short enough to give up. */
const FILE_TIMEOUT_MS = 60_000;

/** `stat -c` in one line: size, mtime in seconds, and the kind. */
const STAT_FORMAT = '%s %Y %F';

export function createDockerFiles(container: string): ExecutionFiles {
  const run = (script: string, args: string[], stdin?: Buffer) =>
    execInContainer(container, script, args, stdin);

  return {
    async readText(path, options) {
      const max = options?.maxBytes;
      // `head -c` rather than reading it all and slicing: the cut happens in
      // the container, so a large file never crosses the pipe.
      const script = max === undefined ? 'cat -- "$1"' : 'head -c "$2" -- "$1"';
      const args = max === undefined ? [path] : [path, String(max)];
      return (await run(script, args)).toString('utf8');
    },

    readBytes: (path) => run('cat -- "$1"', [path]),

    writeText: (path, content) => writeFile(run, path, Buffer.from(content, 'utf8')),
    writeBytes: (path, content) => writeFile(run, path, content),

    async mkdir(path) {
      await run('mkdir -p -- "$1"', [path]);
    },

    async rename(from, to) {
      await run('mv -f -- "$1" "$2"', [from, to]);
    },

    // `-L` follows the link and reports the target, which is what `stat` means
    // here; `lstat` reports the link itself.
    stat: async (path) => parseStat(await run(`stat -L -c '${STAT_FORMAT}' -- "$1"`, [path])),
    lstat: async (path) => parseStat(await run(`stat -c '${STAT_FORMAT}' -- "$1"`, [path])),

    async readDir(path) {
      // One call for names and kinds together. `%y` is the entry's own type, so
      // a symlink reads as a symlink, and `\0` keeps a name with a newline in
      // it whole.
      const out = await run(
        'find -H "$1" -mindepth 1 -maxdepth 1 -printf \'%y %f\\0\'',
        [path],
      );
      return parseDirEntries(out);
    },

    async remove(path) {
      await run('rm -rf -- "$1"', [path]);
    },

    async removeDir(path) {
      await run('rmdir -- "$1"', [path]);
    },

    async symlink(target, linkPath) {
      // `-f` replaces an existing link and `-n` stops `ln` following one that
      // already points at a directory, which would nest the new link inside it.
      await run('ln -sfn -- "$1" "$2"', [target, linkPath]);
    },

    async realpath(path) {
      // `-e` fails when the path does not exist, which is what `realpath(3)`
      // does and what the local implementation reports.
      return (await run('readlink -e -- "$1"', [path])).toString('utf8').trim();
    },
  };
}

async function writeFile(
  run: (script: string, args: string[], stdin?: Buffer) => Promise<Buffer>,
  path: string,
  content: Buffer,
): Promise<void> {
  await run('cat > "$1"', [path], content);
}

/**
 * One command in the container, with its output collected.
 *
 * Throws on a non-zero exit, carrying the engine's own words and — when the
 * shell reported a missing path — the `ENOENT` code, since a caller that
 * branches on a missing file reads `err.code` and the local implementation
 * gives it one.
 */
async function execInContainer(
  container: string,
  script: string,
  args: string[],
  stdin?: Buffer,
): Promise<Buffer> {
  const argv = [
    'exec',
    ...(stdin ? ['-i'] : []),
    container,
    'sh',
    '-c',
    script,
    // `$0` for the shell itself; the caller's arguments start at `$1`.
    'prism-files',
    ...args,
  ];

  const proc = runLocalProgram(DOCKER, argv, {
    cwd: process.cwd(),
    env: process.env,
    stdin: stdin ? 'pipe' : 'ignore',
  });

  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

  if (stdin) {
    proc.stdin?.end(stdin);
  }

  const abandon = setTimeout(() => proc.kill('SIGKILL'), FILE_TIMEOUT_MS);
  abandon.unref();
  const end = await proc.closed.finally(() => clearTimeout(abandon));

  if (end.error) throw end.error;
  if (end.exitCode !== 0) {
    const said = Buffer.concat(err).toString('utf8').trim();
    reportIfContainerLost(container, said);
    throw fileError(said, end.exitCode, args[0]);
  }
  return Buffer.concat(out);
}

function fileError(said: string, exitCode: number | null, path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    said || `the container exited ${exitCode} for ${path}`,
  );
  if (/No such file or directory/i.test(said)) error.code = 'ENOENT';
  else if (/Not a directory/i.test(said)) error.code = 'ENOTDIR';
  else if (/Permission denied/i.test(said)) error.code = 'EACCES';
  else if (/Directory not empty/i.test(said)) error.code = 'ENOTEMPTY';
  return error;
}

/** `<size> <mtime seconds> <kind words>` from one `stat -c` line. */
export function parseStat(out: Buffer): FileStat {
  const line = out.toString('utf8').trim();
  const match = /^(\d+) (\d+) (.+)$/.exec(line);
  if (!match) throw new Error(`could not read a file's details: ${line}`);

  const kind = match[3];
  return {
    size: Number(match[1]),
    mtimeMs: Number(match[2]) * 1000,
    // `stat` spells these out: "regular file", "regular empty file",
    // "directory", "symbolic link".
    isFile: kind.includes('file'),
    isDirectory: kind === 'directory',
    isSymbolicLink: kind === 'symbolic link',
  };
}

/** `<type letter> <name>` records, each ended by a NUL. */
export function parseDirEntries(out: Buffer): DirEntry[] {
  const entries: DirEntry[] = [];
  for (const record of out.toString('utf8').split('\0')) {
    if (record === '') continue;
    const kind = record[0];
    const name = record.slice(2);
    if (name === '') {
      logger.warn({ record }, '[Docker] skipped a directory entry with no name');
      continue;
    }
    entries.push({
      name,
      isFile: kind === 'f',
      isDirectory: kind === 'd',
      isSymbolicLink: kind === 'l',
    });
  }
  return entries;
}
