/**
 * The local environment's workspace root — the default cwd for a command and
 * the base a relative tool path resolves from.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function resolveLocalWorkspaceRoot(): string {
  return path.resolve(process.env.SHELL_WORKSPACE_ROOT || '/home/node');
}

/**
 * Ensure the workspace root exists, creating it if needed.
 *
 * Called once at startup. The default `/home/node` exists in the container but
 * not when running locally (e.g. `npm run dev` on macOS, where `/home` isn't
 * writable). Spawning a shell with a non-existent `cwd` fails as
 * `spawn <cmd> ENOENT` — which looks like a missing shell rather than a missing
 * directory. When the configured root can't be created, fall back to a
 * writable temp dir and pin it via `SHELL_WORKSPACE_ROOT` so every subsequent
 * `resolveLocalWorkspaceRoot()` agrees.
 *
 * Returns the usable root plus, when it differs, the path we couldn't create.
 */
export function prepareLocalWorkspace(): { root: string; fellBackFrom: string | null } {
  const desired = resolveLocalWorkspaceRoot();
  try {
    fs.mkdirSync(desired, { recursive: true });
    return { root: desired, fellBackFrom: null };
  } catch {
    const fallback = path.join(os.tmpdir(), 'prism-workspace');
    fs.mkdirSync(fallback, { recursive: true });
    process.env.SHELL_WORKSPACE_ROOT = fallback;
    return { root: fallback, fellBackFrom: desired };
  }
}
