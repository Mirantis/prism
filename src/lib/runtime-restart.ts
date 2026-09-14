/**
 * Will anything bring this process back if it ends?
 *
 * A Prism plugin's server half loads once per process, so a change to it needs
 * a fresh one. Ending the process to get that is only right where something is
 * waiting to start another — otherwise it takes the agent down and leaves it
 * down, which is worse than not loading the plugin.
 *
 * The same question the self-updater answers with its `gate`, asked of the
 * three shapes this runtime ships in.
 */

import fs from 'fs';
import sea from 'node:sea';

export type NoRespawnReason = 'source_run' | 'windows_scheduled_task';

export interface RespawnGate {
  respawns: boolean;
  reason: NoRespawnReason | null;
}

/**
 * A container. The image runs the server as PID 1 under tini, so the container
 * exits with it and the operator's restart policy starts another — which
 * `docs/docker.md` and the root README document as `--restart unless-stopped`.
 */
function inContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

export function respawnGate(): RespawnGate {
  // An installed binary runs as a service: launchd `KeepAlive` on macOS,
  // systemd `Restart=always` on Linux. Windows registers a Scheduled Task that
  // restarts on failure only, so a clean exit stays exited — the same gap the
  // self-updater works around there by spawning its installer.
  if (sea.isSea()) {
    return process.platform === 'win32'
      ? { respawns: false, reason: 'windows_scheduled_task' }
      : { respawns: true, reason: null };
  }

  if (inContainer()) return { respawns: true, reason: null };

  // A run from source: `tsx watch` restarts on a file change, never on its
  // child exiting, and nothing else is watching.
  return { respawns: false, reason: 'source_run' };
}

/** What to tell the user when a restart is needed and nothing will do it. */
export function restartInstruction(reason: NoRespawnReason): string {
  return reason === 'windows_scheduled_task'
    ? 'Restart the prism-server scheduled task to load it.'
    : 'Restart the runtime to load it.';
}
