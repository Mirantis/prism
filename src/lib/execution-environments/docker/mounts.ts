/**
 * What the exec container can see.
 *
 * Every path is bind-mounted at the **identical absolute path** it has on the
 * host, so a path means the same file on both sides and nothing anywhere has to
 * translate one into the other. That is also what keeps the container
 * disposable: the bytes live on the host, and losing the container loses
 * nothing durable.
 *
 * What is left out is as deliberate as what is in. The database is the
 * runtime's alone, the media store is copied *into* the workspace by
 * `hydrate_attachment` rather than shared, a plugin's MCP server runs on the
 * host, and the browser profiles belong to the meeting and computer stacks.
 */
import * as path from 'path';

export interface ContainerPaths {
  /** The default workspace root — the cwd of a command that names no other. */
  workspaceRoot: string;
  skillsDir: string;
  pluginsDir: string;
  toolOutputDir: string;
  /** The coding agents' config homes, `<data>/.claude` and `<data>/.codex`. */
  codingAgentHomes: readonly string[];
  /** Where a command records its process group id, so a kill can find it. */
  runDir: string;
  /**
   * `$HOME` inside the container. A real, persistent directory rather than the
   * image's fallback, so a package cache or a `gh auth login` survives a
   * restart — and outside the workspace, so dotfiles never land in the user's
   * repository.
   */
  homeDir: string;
}

/**
 * The host paths to mount, deduplicated and with a nested path dropped when an
 * ancestor is already mounted — `--mount` twice over the same subtree is an
 * error on some engines and pointless on the rest.
 */
export function mountPaths(paths: ContainerPaths): string[] {
  const wanted = [
    paths.workspaceRoot,
    paths.skillsDir,
    paths.pluginsDir,
    paths.toolOutputDir,
    ...paths.codingAgentHomes,
    paths.runDir,
    paths.homeDir,
  ].map((p) => path.resolve(p));

  const unique = [...new Set(wanted)].sort();
  return unique.filter(
    (candidate, index) => !unique.slice(0, index).some((earlier) => isInside(candidate, earlier)),
  );
}

/** Whether a command with this cwd can run against the given mounts. */
export function servesPath(mounts: readonly string[], candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return mounts.some((mount) => isInside(resolved, mount));
}

/**
 * The mounts that would hand the container something the runtime keeps to
 * itself — the database above all.
 *
 * The nesting rule above is what makes this possible: a workspace root set to
 * the data dir, or to an ancestor of it, collapses every other mount into that
 * one and carries `agent.db`, the media store and the plugin scratch in with
 * it. The configuration is legal and the boundary would disappear silently, so
 * the environment refuses to start on it rather than narrowing what it claims.
 */
export function mountsExposing(mounts: readonly string[], runtimeOwned: string): string[] {
  const owned = path.resolve(runtimeOwned);
  return mounts.filter((mount) => isInside(owned, mount));
}

/**
 * Whether `candidate` is `base` or sits under it. The separator matters:
 * `/data/skills-other` starts with `/data/skills` as a string but is a
 * different directory.
 */
function isInside(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  return candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
