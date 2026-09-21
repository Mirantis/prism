/**
 * Files for the local environment: the filesystem this process runs on.
 */
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import type { DirEntry, ExecutionFiles, FileStat } from '../execution-environment';

export const localFiles: ExecutionFiles = {
  async readText(path, options) {
    const maxBytes = options?.maxBytes;
    if (maxBytes === undefined) return fs.readFile(path, 'utf8');
    const handle = await fs.open(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },

  readBytes(path) {
    return fs.readFile(path);
  },

  async writeText(path, content) {
    await fs.writeFile(path, content, 'utf8');
  },

  async writeBytes(path, content) {
    await fs.writeFile(path, content);
  },

  async mkdir(path) {
    await fs.mkdir(path, { recursive: true });
  },

  rename(from, to) {
    return fs.rename(from, to);
  },

  async stat(path) {
    return toFileStat(await fs.stat(path));
  },

  async lstat(path) {
    return toFileStat(await fs.lstat(path));
  },

  async readDir(path) {
    const dirents = await fs.readdir(path, { withFileTypes: true });
    return dirents.map(
      (d): DirEntry => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      }),
    );
  },

  async remove(path) {
    await fs.rm(path, { recursive: true, force: true });
  },

  async removeDir(path) {
    await fs.rmdir(path);
  },

  async symlink(target, linkPath) {
    // Replace an existing *link*, which may point somewhere stale, and refuse
    // anything else: a real directory there holds somebody's files. `ln -sfn`
    // draws the same line, so both environments answer alike.
    try {
      if ((await fs.lstat(linkPath)).isSymbolicLink()) await fs.unlink(linkPath);
    } catch {
      // Nothing there, which is the ordinary case.
    }
    await fs.symlink(target, linkPath);
  },

  realpath: (path) => fs.realpath(path),
};

function toFileStat(st: Stats): FileStat {
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}
