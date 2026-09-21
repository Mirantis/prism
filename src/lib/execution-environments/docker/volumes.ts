/**
 * What the exec container stores, and where.
 *
 * Every durable path is a **named volume** the engine owns, mounted at a fixed
 * path under `/prism`. Two things follow from that, and they are the whole
 * design.
 *
 * The paths are the container's own rather than this machine's, because a
 * named volume has no path on this machine to agree with — on macOS and
 * Windows it is not even on this machine, it is inside the engine's virtual
 * one. Fixing them also lets the image create each directory, which is what
 * makes a fresh volume writable by a container running as the runtime's user:
 * the engine seeds a new volume from the image's directory, mode and all.
 *
 * The volumes outlive the container. `shutdown` removes the container and
 * nothing else, so the workspace, the skills, the plugins and both coding
 * agents' logins are still there for the next boot, and for a `docker cp`.
 */

/** The container's root for everything the agent works with. */
export const PRISM_ROOT = '/prism';

export const CONTAINER_PATHS = {
  workspaceRoot: `${PRISM_ROOT}/workspace`,
  skillsDir: `${PRISM_ROOT}/skills`,
  pluginsDir: `${PRISM_ROOT}/plugins`,
  toolOutputDir: `${PRISM_ROOT}/tool-outputs`,
  claudeHome: `${PRISM_ROOT}/claude`,
  codexHome: `${PRISM_ROOT}/codex`,
  /**
   * `$HOME`. A package cache and a `gh auth login` land here, so it is kept
   * like the rest — and outside the workspace, so dotfiles stay out of the
   * user's repository.
   */
  homeDir: `${PRISM_ROOT}/home`,
} as const;

export type VolumePurpose = keyof typeof CONTAINER_PATHS;

/**
 * The volume behind each path, named for the deployment so two runtimes on one
 * host never share one. The digest is the same one the container is named
 * after, so `docker volume ls` groups them beside it.
 */
export function volumeName(deployment: string, purpose: VolumePurpose): string {
  return `prism-exec-${deployment}-${kebab(purpose)}`;
}

/** Every `--volume name:path` pair the container is created with. */
export function volumeMounts(deployment: string): Array<{ name: string; path: string }> {
  return purposes().map((purpose) => ({
    name: volumeName(deployment, purpose),
    path: CONTAINER_PATHS[purpose],
  }));
}

export function purposes(): VolumePurpose[] {
  return Object.keys(CONTAINER_PATHS) as VolumePurpose[];
}

/**
 * Whether a command with this cwd can run here.
 *
 * Only the container's own tree, so a thread rooted in a repository on this
 * machine answers false and runs locally — the same rule as before, against a
 * namespace that is now the container's.
 */
export function servesPath(candidate: string): boolean {
  if (!candidate.startsWith('/')) return false;
  const normalized = normalize(candidate);
  return normalized === PRISM_ROOT || normalized.startsWith(`${PRISM_ROOT}/`);
}

/**
 * Resolve `.` and `..` without touching this machine's filesystem: a container
 * path is POSIX whatever the host is, so `path.resolve` is wrong on Windows
 * and `path.posix.resolve` would still read this process's cwd for a relative
 * one, which is a host path. A relative path is rejected above instead.
 */
function normalize(candidate: string): string {
  const out: string[] = [];
  for (const part of candidate.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function kebab(purpose: string): string {
  return purpose.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
