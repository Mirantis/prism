import fs from 'fs';
import path from 'path';
import { ApiError } from '../api-client.js';
import { expandPath } from '../attachments.js';
import type { SlashCommand } from './types.js';

export const saveCommand: SlashCommand = {
  name: '/save',
  description: 'Save the agent’s shared file(s) to disk (/save [dir|file])',
  run: async (ctx) => {
    const files = ctx.recentAttachments;
    if (files.length === 0) return 'No files from the agent to save.';

    const destArg = ctx.rawArgs.trim();
    const cwd = process.cwd();
    let targetDir: string;
    // When the user names a concrete file path (single file only), write
    // there verbatim; otherwise we write into a directory keeping names.
    let singleFilePath: string | null = null;

    if (destArg.length === 0) {
      targetDir = cwd;
    } else {
      const resolved = path.resolve(cwd, expandPath(destArg));
      const endsWithSep = /[\\/]$/.test(destArg);
      let existsAsDir = false;
      let existsAsFile = false;
      try {
        const st = await fs.promises.stat(resolved);
        existsAsDir = st.isDirectory();
        existsAsFile = st.isFile();
      } catch {
        // Path doesn't exist yet.
      }
      // Treat as a directory when it already is one, ends with a separator,
      // or doesn't exist yet but several files are pending (so `/save out`
      // can create `out/` and drop them all in). A single pending file with
      // a non-existent path is written verbatim to that path.
      if (existsAsDir || endsWithSep || (!existsAsFile && files.length > 1)) {
        targetDir = resolved;
      } else if (files.length === 1) {
        singleFilePath = resolved;
        targetDir = path.dirname(resolved);
      } else {
        return `"${destArg}" is an existing file but ${files.length} files are pending — give a directory instead.`;
      }
    }

    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
    } catch (err) {
      return `Could not create ${targetDir}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const saved: string[] = [];
    const failed: string[] = [];
    const taken = new Set<string>();
    for (const att of files) {
      // basename() guards against a server-supplied filename with path parts.
      const outPath = singleFilePath ?? freePath(path.join(targetDir, path.basename(att.filename)), taken);
      try {
        const bytes = await ctx.api.downloadAttachment(att.id);
        await fs.promises.writeFile(outPath, bytes);
        saved.push(outPath);
      } catch (err) {
        if (!(err instanceof ApiError || err instanceof Error)) throw err;
        failed.push(`Failed to save ${att.filename}: ${err.message}`);
      }
    }
    const lines = saved.length > 0 ? [`Saved ${saved.length} file(s):`, ...saved.map((p) => `  ${p}`)] : [];
    return [...lines, ...failed].join('\n');
  },
};

/** `chart.png`, else `chart-2.png`, `chart-3.png`…: one path per file of this save. */
function freePath(wanted: string, taken: Set<string>): string {
  const { dir, name, ext } = path.parse(wanted);
  let candidate = wanted;
  for (let n = 2; taken.has(candidate); n++) candidate = path.join(dir, `${name}-${n}${ext}`);
  taken.add(candidate);
  return candidate;
}
