/**
 * The desktop's controls, by name and rectangle, from the accessibility tree.
 *
 * GTK applications, the XFCE panel and its menus among them, describe every widget over
 * AT-SPI: its role, its name and where it is on the screen. That is the exact answer to
 * "where is Mail Reader", with no picture and no estimate, and it is what lets a click
 * by name land on a widget's centre. A short Python program over `pyatspi` walks the
 * tree and prints the visible, named widgets as JSON; it runs with Debian's Python,
 * since the image's PATH puts a mise-managed one first, which has no `pyatspi`.
 *
 * Not everything is in the tree. The window manager's own title-bar buttons are not
 * widgets (see `desktop-windows.ts`), plain X11 programs such as the card games describe
 * nothing, and Chromium describes its own frame but not the page unless asked to. OCR
 * (`screen-text.ts`) covers the rest.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/** One visible, named widget, in screen pixels. */
export interface ScreenElement {
  app: string;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Debian's interpreter, the one `python3-pyatspi` installs into. */
const PYTHON = '/usr/bin/python3';
const DUMP_TIMEOUT_MS = 15_000;
/** Widgets a person clicks, types into or reads, plus the windows they sit in. */
export const ACTIONABLE_ROLES = new Set([
  'menu item', 'menu', 'check menu item', 'radio menu item',
  'push button', 'toggle button', 'check box', 'radio button',
  'page tab', 'list item', 'tree item', 'link',
  'text', 'entry', 'password text', 'combo box', 'spin button', 'slider',
  'icon', 'frame', 'dialog',
]);

const DUMP_SCRIPT = `
import json
import pyatspi
ROLES = ${JSON.stringify([...ACTIONABLE_ROLES, 'label'])}
out = []
def walk(acc, depth, app):
    if depth > 14 or len(out) > 800:
        return
    try:
        children = list(acc)
    except Exception:
        return
    for child in children:
        try:
            st = child.getState()
            if not (st.contains(pyatspi.STATE_VISIBLE) and st.contains(pyatspi.STATE_SHOWING)):
                continue
            role = child.getRoleName()
            name = child.name or ""
            if role in ROLES and name:
                x, y, w, h = child.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                if w > 0 and h > 0:
                    out.append({"app": app, "role": role, "name": name, "x": x, "y": y, "width": w, "height": h})
        except Exception:
            pass
        walk(child, depth + 1, app)
desktop = pyatspi.Registry.getDesktop(0)
for app in desktop:
    try:
        walk(app, 0, app.name or "")
    except Exception:
        pass
print(json.dumps(out))
`;

/** Walk the accessibility tree. `env` carries DISPLAY and the session bus address. */
export async function readScreenElements(env: Record<string, string>): Promise<ScreenElement[]> {
  const { stdout } = await run(PYTHON, ['-c', DUMP_SCRIPT], {
    env: { ...process.env, ...env },
    timeout: DUMP_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is ScreenElement =>
      typeof e === 'object' && e !== null && typeof (e as ScreenElement).name === 'string',
  );
}

/** Letters and digits only, lower case, the same as `screen-text.ts`. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The widgets whose name is `query`, top to bottom: a whole-name match first, then names
 * that contain the query, so "Close" finds "Close" before "Close all tabs". Only widgets a
 * person acts on; a plain label is not a target.
 */
export function findElements(elements: ScreenElement[], query: string): ScreenElement[] {
  const wanted = normalize(query);
  if (!wanted) return [];
  const candidates = elements.filter((e) => ACTIONABLE_ROLES.has(e.role));
  const exact = candidates.filter((e) => normalize(e.name) === wanted);
  const found = exact.length > 0 ? exact : candidates.filter((e) => normalize(e.name).includes(wanted));
  return found.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The controls as a reading for the model, grouped by program, the way `browse` reports a
 * page's controls. Windows first in each group, then the rest top to bottom.
 */
export function describeElements(elements: ScreenElement[], filter?: string): string {
  const wanted = filter ? normalize(filter) : '';
  const shown = elements.filter(
    (e) => ACTIONABLE_ROLES.has(e.role) && (!wanted || normalize(e.name).includes(wanted)),
  );
  if (shown.length === 0) return filter ? `No control named like "${filter}" is on the screen.` : 'No controls are on the screen.';

  const byApp = new Map<string, ScreenElement[]>();
  for (const e of shown) byApp.set(e.app, [...(byApp.get(e.app) ?? []), e]);
  const lines: string[] = [];
  for (const [app, items] of byApp) {
    lines.push(`${app || 'unknown program'}:`);
    items.sort((a, b) => Number(b.role === 'frame') - Number(a.role === 'frame') || a.y - b.y || a.x - b.x);
    for (const e of items) {
      const cx = Math.round(e.x + e.width / 2);
      const cy = Math.round(e.y + e.height / 2);
      lines.push(`  ${e.role} "${e.name}" at (${cx}, ${cy})`);
    }
  }
  return lines.join('\n');
}
