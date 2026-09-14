/**
 * Whether a program is installed on this host.
 *
 * Each feature that shells out to a toolchain checks its own binaries before it offers
 * itself: voice meetings check the audio stack, the agent's computer checks the desktop
 * packages. Both ask here, so there is one definition of "on PATH".
 */

import { promises as fs } from 'fs';
import path from 'path';

/** The first named program that is not on PATH, or null when all of them are. */
export async function missingBinary(...names: string[]): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    const found = await Promise.all(
      dirs.map(async (dir) => {
        try {
          await fs.access(path.join(dir, name));
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (!found.includes(true)) return name;
  }
  return null;
}

/** Whether every named program is on PATH. */
export async function hasBinaries(...names: string[]): Promise<boolean> {
  return (await missingBinary(...names)) === null;
}
