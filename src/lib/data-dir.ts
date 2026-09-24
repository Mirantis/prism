/**
 * Single source of truth for the persistent **data directory** — the place
 * that survives container/process restarts and holds the agent's durable
 * state. Today that location is implicit in `DATABASE_URL` (set per context:
 * `/data` in the container via start.sh, `~/.prism` for the SEA binary via
 * server-entry.ts). This module makes it explicit so anything that needs a
 * persistent home (skills, plugins, the coding agent's config dir) derives
 * from one place.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Resolve the persistent data dir.
 *
 *  1. `PRISM_DATA_DIR` when set — the container image bakes
 *     `PRISM_DATA_DIR=/data` (the mounted volume), so in-container this is `/data`.
 *     It's also the pin set by the temp-dir fallback below so every resolver
 *     agrees within a process, and an operator can override it.
 *  2. `~/.prism` — everywhere else (local dev, the packaged SEA binary, which
 *     also keeps its DB under `~/.prism`).
 */
export function resolveDataDir(): string {
  const dir = process.env.PRISM_DATA_DIR?.trim();
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), '.prism');
}

/** Canonical, tool-agnostic skills directory. Overridable via `PRISM_SKILLS_DIR`. */
export function resolveSkillsDir(): string {
  const override = process.env.PRISM_SKILLS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'skills');
}

/** Canonical Agent Plugins directory. Overridable via `PRISM_PLUGINS_DIR`. */
export function resolvePluginsDir(): string {
  const override = process.env.PRISM_PLUGINS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'plugins');
}

/**
 * Media directory for attachment content (`/data/media` in the container).
 * Attachment bytes live here as files — the DB row keeps only metadata plus
 * the file's basename (see `lib/media-store.ts`, the sole reader/writer).
 */
export function resolveMediaDir(): string {
  return path.join(resolveDataDir(), 'media');
}

/**
 * Where an oversized tool result is saved so the omitted middle stays reachable
 * (`/data/tool-outputs` in the container). Files only — no DB row points at one,
 * so a spill's whole lifecycle is its mtime against the TTL. See
 * `lib/tool-output-store.ts`, the sole reader/writer.
 */
export function resolveToolOutputDir(): string {
  return path.join(resolveDataDir(), 'tool-outputs');
}

export interface DataDirsSetup {
  dataDir: string;
  skillsDir: string;
  pluginsDir: string;
  mediaDir: string;
  toolOutputDir: string;
  /** The intended data dir we couldn't create (so the caller can warn), else null. */
  fellBackFrom: string | null;
}

/**
 * Idempotently create a symlink at `linkPath` pointing to `target`. Returns
 * whether the link is in place afterwards. A real (non-symlink) directory at
 * `linkPath` is only replaced when empty — we never delete a populated dir we
 * didn't create.
 */
export function ensureSymlink(target: string, linkPath: string): boolean {
  try {
    const st = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) === target) return true; // already correct
        fs.unlinkSync(linkPath);
      } else if (st.isDirectory()) {
        if (fs.readdirSync(linkPath).length > 0) return false; // populated — leave it
        fs.rmdirSync(linkPath);
      } else {
        fs.unlinkSync(linkPath);
      }
    }
    // On Windows a directory symlink needs an explicit type; "junction" works
    // without elevated privileges. POSIX ignores the third arg.
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the data dir and the canonical skills, plugins, media and tool-output
 * dirs exist. The coding agent's own home inside the data dir is the adapter's
 * business (`CodingAgent.prepareHome`), run by `index.ts` right after this.
 *
 * Mirrors `ensureWorkspaceRoot()`'s temp-dir fallback: when the intended data
 * dir can't be created (e.g. `/data` on a local macOS run), fall back to a
 * writable temp dir and pin it via `PRISM_DATA_DIR` so every subsequent resolve
 * agrees. Called once at startup, before any tool can spawn.
 */
export function ensureDataDirs(): DataDirsSetup {
  const desired = resolveDataDir();
  let dataDir = desired;
  let fellBackFrom: string | null = null;
  try {
    fs.mkdirSync(desired, { recursive: true });
  } catch {
    const fallback = path.join(os.tmpdir(), 'prism-data');
    fs.mkdirSync(fallback, { recursive: true });
    process.env.PRISM_DATA_DIR = fallback; // pin so all resolvers agree
    dataDir = fallback;
    fellBackFrom = desired;
  }

  const skillsDir = resolveSkillsDir();
  const pluginsDir = resolvePluginsDir();
  const mediaDir = resolveMediaDir();
  const toolOutputDir = resolveToolOutputDir();
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(toolOutputDir, { recursive: true });

  return {
    dataDir,
    skillsDir,
    pluginsDir,
    mediaDir,
    toolOutputDir,
    fellBackFrom,
  };
}
