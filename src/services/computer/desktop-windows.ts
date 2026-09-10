/**
 * The desktop's windows, by title, through `wmctrl`.
 *
 * A window's title-bar buttons belong to the window manager and are not in the
 * accessibility tree, and at 25 pixels they are the targets the model misses most. So a
 * window is never clicked to be managed: `wmctrl` names it by title and focuses, closes,
 * maximises or restores it directly; `xdotool` minimises, which this `wmctrl` cannot.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export interface DesktopWindow {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowAction = 'focus' | 'close' | 'maximize' | 'restore' | 'minimize';

const COMMAND_TIMEOUT_MS = 10_000;
/** The desktop's own furniture, shown by `wmctrl` as windows on every workspace. */
const FURNITURE = new Set(['xfce4-panel', 'Desktop']);

/** Every window a person would call one, top to bottom. */
export async function listWindows(env: Record<string, string>): Promise<DesktopWindow[]> {
  const { stdout } = await run('wmctrl', ['-l', '-G'], {
    env: { ...process.env, ...env },
    timeout: COMMAND_TIMEOUT_MS,
  });
  const windows: DesktopWindow[] = [];
  for (const line of stdout.split('\n')) {
    // id, workspace (-1 for every workspace), x, y, width, height, host, title.
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/);
    if (!m) continue;
    const title = m[7].trim();
    if (m[2] === '-1' || FURNITURE.has(title) || !title) continue;
    windows.push({
      id: m[1],
      title,
      x: Number(m[3]),
      y: Number(m[4]),
      width: Number(m[5]),
      height: Number(m[6]),
    });
  }
  return windows.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The windows whose title is or contains `query`, the way `findElements` matches names. */
export function findWindows(windows: DesktopWindow[], query: string): DesktopWindow[] {
  const wanted = query.toLowerCase().trim();
  if (!wanted) return [];
  const exact = windows.filter((w) => w.title.toLowerCase() === wanted);
  return exact.length > 0 ? exact : windows.filter((w) => w.title.toLowerCase().includes(wanted));
}

export async function actOnWindow(
  env: Record<string, string>,
  window: DesktopWindow,
  action: WindowAction,
): Promise<void> {
  const options = { env: { ...process.env, ...env }, timeout: COMMAND_TIMEOUT_MS };
  switch (action) {
    case 'focus':
      await run('wmctrl', ['-i', '-a', window.id], options);
      return;
    case 'close':
      await run('wmctrl', ['-i', '-c', window.id], options);
      return;
    case 'maximize':
      await run('wmctrl', ['-i', '-r', window.id, '-b', 'add,maximized_vert,maximized_horz'], options);
      return;
    case 'restore':
      await run('wmctrl', ['-i', '-r', window.id, '-b', 'remove,maximized_vert,maximized_horz'], options);
      await run('wmctrl', ['-i', '-r', window.id, '-b', 'remove,hidden'], options);
      return;
    case 'minimize':
      await run('xdotool', ['windowminimize', window.id], options);
      return;
  }
}
