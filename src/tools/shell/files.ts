/**
 * File manipulation tools:
 *   - shell_read_file
 *   - shell_write_file
 *   - shell_edit_file
 *
 * Mirror the upstream input schemas + behavior from the Lens Agents shell
 * sandbox's shell schemas and file handlers.
 *
 * Security model (inherited from upstream): `resolvePath` resolves
 * relative paths against the workspace root and normalizes absolute
 * paths as-is; `isInsideWorkspace` then rejects anything not contained
 * in the workspace. Net effect: relative `..` traversal AND absolute
 * paths outside the workspace are both rejected. Real boundary is
 * still filesystem permissions; this layer matches the upstream shell
 * sandbox's workspace semantics.
 *
 * The skills and plugins directories are reachable as well, since that is where a skill
 * or a plugin is installed and the prompt tells the agent to put one there.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { resolvePluginsDir, resolveSkillsDir } from '../../lib/data-dir';
import { resolvePath, isInsideWorkspace } from './workspace';
import { applyEdit } from './edit';
import { formatFileContent } from './format';

export const readFileInput = z.object({
  path: z.string().describe('File path. Relative paths are resolved from the workspace root.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Line number to start reading from (1-indexed, default: 1)'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to read (default: 2000)'),
});

export const writeFileInput = z.object({
  path: z.string().describe('File path. Relative paths are resolved from the workspace root.'),
  content: z.string().describe('File content to write'),
});

export const editFileInput = z.object({
  path: z.string().describe('File path. Relative paths are resolved from the workspace root.'),
  old_string: z.string().describe('The exact text to find and replace'),
  new_string: z
    .string()
    .describe('The replacement text (must differ from old_string)'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences (default: false, requires unique match)'),
});

/**
 * Where a file tool may work, beyond the workspace root.
 *
 * A skill and a plugin are installed by landing a bundle in the data dir, which is what
 * the `# Skills` and `# Plugins` sections of the prompt tell the agent to do. `shell_exec`
 * has always been able to write there — it takes a command rather than a path, so nothing
 * checks where it lands — so a file tool refusing the same write left the two disagreeing
 * and made the prompt's own instruction false for one of them.
 *
 * Read on each call rather than once: `PRISM_SKILLS_DIR` and `PRISM_PLUGINS_DIR` move
 * these, and a test sets them per case.
 *
 * The rest of the data dir stays out. The database, the stored attachments and the saved
 * tool outputs are the runtime's own files, and a tool that overwrites a whole file has no
 * business in them.
 */
function installDirs(): string[] {
  return [resolveSkillsDir(), resolvePluginsDir()];
}

function rejectOutsideWorkspace(fullPath: string, workspace: string): string | null {
  if (isInsideWorkspace(fullPath, workspace)) return null;
  const reachable = installDirs();
  if (reachable.some((dir) => isInsideWorkspace(fullPath, dir))) return null;
  return `Path outside workspace. Write under ${workspace}, or into ${reachable.join(' or ')}.`;
}

export async function runReadFile(
  input: z.infer<typeof readFileInput>,
  workspace: string,
): Promise<{ content: string } | { error: string }> {
  const fullPath = resolvePath(workspace, input.path);
  const rejected = rejectOutsideWorkspace(fullPath, workspace);
  if (rejected) return { error: rejected };
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    return { content: formatFileContent(raw, input.offset, input.limit) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWriteFile(
  input: z.infer<typeof writeFileInput>,
  workspace: string,
): Promise<{ ok: true } | { error: string }> {
  const fullPath = resolvePath(workspace, input.path);
  const rejected = rejectOutsideWorkspace(fullPath, workspace);
  if (rejected) return { error: rejected };
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runEditFile(
  input: z.infer<typeof editFileInput>,
  workspace: string,
): Promise<{ ok: true } | { error: string }> {
  const fullPath = resolvePath(workspace, input.path);
  const rejected = rejectOutsideWorkspace(fullPath, workspace);
  if (rejected) return { error: rejected };
  let original: string;
  try {
    original = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const edit = applyEdit(original, input.old_string, input.new_string, input.replace_all ?? false);
  if (!edit.ok) return { error: edit.message };
  try {
    await fs.writeFile(fullPath, edit.content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
