import { promises as fs } from 'fs';
import path from 'path';

/** Whether every named program is on PATH, the way `isMeetingSupported` checks its own. */
export async function hasBinaries(...names: string[]): Promise<boolean> {
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
    if (!found.includes(true)) return false;
  }
  return true;
}
