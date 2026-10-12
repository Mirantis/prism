/**
 * Stop a process the agent started that a crash of the runtime left running.
 * Each agent process leads its own group, so a `SIGKILL` of the runtime does not
 * reach it. The mark names the process; the group is killed only while the
 * process with that pid is still the one that started at the marked time.
 */

import { execFile } from 'child_process';
import type { ProcessMark } from './execution-environment';

/** How far the start time `ps` gives may stray from the mark's: `ps` counts whole seconds. */
const START_TOLERANCE_MS = 3_000;

/** Kill the marked process group. True when it was still running and was killed. */
export async function stopLeftoverProcess(mark: ProcessMark): Promise<boolean> {
  const elapsed = await elapsedMs(mark.pid);
  if (elapsed === null) return false;
  if (Math.abs(Date.now() - elapsed - mark.startedAt) > START_TOLERANCE_MS) return false;
  try {
    process.kill(-mark.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** How long the process has run, or null when no process has that pid. */
function elapsedMs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=', '-p', String(pid)], (err, stdout) => {
      resolve(err ? null : parseElapsed(stdout.trim()));
    });
  });
}

/** The elapsed time `ps` prints, `[[dd-]hh:]mm:ss`, in milliseconds. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
