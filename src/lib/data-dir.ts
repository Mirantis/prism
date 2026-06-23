/**
 * Single source of truth for the persistent **data directory** — the place
 * that survives container/process restarts and holds the agent's durable
 * state. Today that location is implicit in `DATABASE_URL` (set per context:
 * `/data` in the container via start.sh, `~/.prism` for the SEA binary via
 * server-entry.ts). This module makes it explicit so anything that needs a
 * persistent home (skills, Claude Code's config dir) derives from one place.
 *
 * It also owns the Claude Code interop: the embedded `claude_code` tool spawns
 * the real `claude` CLI, which discovers skills under `$CLAUDE_CONFIG_DIR/skills`.
 * We point `CLAUDE_CONFIG_DIR` at a dir *inside* our data dir and symlink its
 * `skills` child to the canonical skills dir — so both the prism loop and
 * `claude_code` read the same bytes, and we never touch the user's real
 * `~/.claude`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** The container's mounted persistent volume. */
const CONTAINER_DATA_DIR = '/data';

function isWritableDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && (fs.accessSync(p, fs.constants.W_OK), true);
  } catch {
    return false;
  }
}

/**
 * Resolve the persistent data dir.
 *
 *  1. `PRISM_DATA_DIR` — explicit operator override (also the pin set by the
 *     temp-dir fallback below, so every resolver agrees within a process).
 *  2. `/data` when it's a writable directory — i.e. inside the container, where
 *     the persistent volume is mounted there.
 *  3. `~/.prism` — everywhere else (local dev, the packaged SEA binary, which
 *     also keeps its DB under `~/.prism`).
 */
export function resolveDataDir(): string {
  const override = process.env.PRISM_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  if (isWritableDir(CONTAINER_DATA_DIR)) return CONTAINER_DATA_DIR;
  return path.join(os.homedir(), '.prism');
}

/** Canonical, tool-agnostic skills directory. Overridable via `PRISM_SKILLS_DIR`. */
export function resolveSkillsDir(): string {
  const override = process.env.PRISM_SKILLS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'skills');
}

/**
 * The config dir we point Claude Code at via `CLAUDE_CONFIG_DIR`. Lives inside
 * our data dir so Claude Code's own state (sessions, `.claude.json`) is isolated
 * there rather than polluting the data-dir root next to `agent.db` — and so we
 * never touch the user's real `~/.claude`.
 */
export function resolveClaudeConfigDir(): string {
  return path.join(resolveDataDir(), '.claude');
}

export interface DataDirsSetup {
  dataDir: string;
  skillsDir: string;
  claudeConfigDir: string;
  /** The intended data dir we couldn't create (so the caller can warn), else null. */
  fellBackFrom: string | null;
  /** Whether the Claude Code skills symlink is in place. */
  symlinkOk: boolean;
}

/**
 * Idempotently create a symlink at `linkPath` pointing to `target`. Returns
 * whether the link is in place afterwards. A real (non-symlink) directory at
 * `linkPath` is only replaced when empty — we never delete a populated dir we
 * didn't create.
 */
function ensureSymlink(target: string, linkPath: string): boolean {
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
 * Ensure the data dir, the canonical skills dir, and the Claude Code config dir
 * exist; (re)create the `<claudeConfigDir>/skills` → `<skillsDir>` symlink; and
 * default `CLAUDE_CONFIG_DIR` so the spawned `claude_code` CLI discovers the
 * same skills.
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
  const claudeConfigDir = resolveClaudeConfigDir();
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  const symlinkOk = ensureSymlink(skillsDir, path.join(claudeConfigDir, 'skills'));

  // Default (don't override an operator-set value) so the spawned `claude` CLI
  // — which inherits process.env — reads skills from our shared dir.
  process.env.CLAUDE_CONFIG_DIR ??= claudeConfigDir;

  return { dataDir, skillsDir, claudeConfigDir, fellBackFrom, symlinkOk };
}
