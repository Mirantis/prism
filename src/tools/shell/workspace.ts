/**
 * Workspace path helpers, ported from the upstream Mirantis Agent Platform shell
 * sandbox.
 *
 * - `resolvePath` turns a tool-supplied path into an absolute path.
 *   Relative paths are resolved from the workspace root; absolute
 *   paths pass through as-is.
 * - `isInsideWorkspace` reports whether a normalized path is contained
 *   within the workspace root. Callers use it to reject writes that
 *   would escape the workspace via `..` traversal. It is **not** a
 *   security boundary — the real boundary is filesystem permissions
 *   (matches upstream's semantics: absolute paths outside the
 *   workspace pass through and the check returns false).
 */
import * as path from 'path';

function normalize(p: string): string {
  // Node's path.normalize handles `.` and `..` but doesn't strip a
  // leading `..` from absolute paths. Compose it with path.resolve()
  // semantics: keep absolute-ness, collapse components.
  const isAbs = path.isAbsolute(p);
  const parts: string[] = [];
  for (const seg of p.split(path.sep)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbs) parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join(path.sep);
  return isAbs ? path.sep + joined : joined;
}

export function resolvePath(workspace: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return normalize(inputPath);
  }
  return normalize(path.join(workspace, inputPath));
}

export function isInsideWorkspace(fullPath: string, workspace: string): boolean {
  const normalized = normalize(fullPath);
  const normalizedWorkspace = normalize(workspace);
  if (normalized === normalizedWorkspace) return true;
  return normalized.startsWith(normalizedWorkspace + path.sep);
}
