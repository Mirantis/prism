import { describe, expect, it } from 'vitest';
import { describeElements, findElements, type ScreenElement } from '../screen-elements';
import { findWindows, type DesktopWindow } from '../desktop-windows';

// What the tree dump produced on the XFCE desktop with the Applications menu open.
const ELEMENTS: ScreenElement[] = [
  { app: 'xfce4-panel', role: 'menu item', name: 'File Manager', x: 0, y: 82, width: 190, height: 25 },
  { app: 'xfce4-panel', role: 'menu item', name: 'Mail Reader', x: 0, y: 107, width: 190, height: 25 },
  { app: 'xfce4-panel', role: 'menu', name: 'Games', x: 0, y: 209, width: 190, height: 25 },
  { app: 'xfce4-panel', role: 'menu item', name: 'Log Out', x: 0, y: 310, width: 190, height: 25 },
  { app: 'xfce4-terminal', role: 'menu', name: 'File', x: 5, y: 56, width: 48, height: 25 },
  { app: 'xfce4-terminal', role: 'frame', name: 'Terminal - root@box: /app', x: 0, y: 31, width: 825, height: 520 },
  { app: 'xfce4-terminal', role: 'label', name: 'File', x: 10, y: 60, width: 30, height: 15 },
];

describe('findElements', () => {
  it('finds a control by its whole name, ignoring case and punctuation', () => {
    const [found] = findElements(ELEMENTS, 'mail reader');
    expect(found.name).toBe('Mail Reader');
    expect(findElements(ELEMENTS, 'Log out.')).toHaveLength(1);
  });

  it('prefers a whole-name match over names that merely contain the query', () => {
    const found = findElements(ELEMENTS, 'File');
    expect(found.map((e) => e.name)).toEqual(['File']);
    expect(found[0].role).toBe('menu');
  });

  it('falls back to names containing the query', () => {
    expect(findElements(ELEMENTS, 'Manager').map((e) => e.name)).toEqual(['File Manager']);
  });

  it('never returns a plain label, which is not a target', () => {
    expect(findElements(ELEMENTS, 'File').some((e) => e.role === 'label')).toBe(false);
  });

  it('answers empty for a name that is not there', () => {
    expect(findElements(ELEMENTS, 'Web Browser')).toHaveLength(0);
  });
});

describe('describeElements', () => {
  it('groups controls by program with their centres, windows first', () => {
    const text = describeElements(ELEMENTS);
    expect(text).toContain('xfce4-panel:');
    expect(text).toContain('menu item "Mail Reader" at (95, 120)');
    const terminal = text.slice(text.indexOf('xfce4-terminal:'));
    expect(terminal.indexOf('frame "Terminal')).toBeLessThan(terminal.indexOf('menu "File"'));
    expect(text).not.toContain('label "File"');
  });

  it('filters by name and says when nothing matches', () => {
    expect(describeElements(ELEMENTS, 'game')).toContain('menu "Games"');
    expect(describeElements(ELEMENTS, 'game')).not.toContain('Mail Reader');
    expect(describeElements(ELEMENTS, 'nothing here')).toContain('No control named like');
  });
});

describe('findWindows', () => {
  const windows: DesktopWindow[] = [
    { id: '0x1', title: 'Terminal - root@box: /app', x: 0, y: 31, width: 825, height: 520 },
    { id: '0x2', title: 'The Ace of Penguins - ace-solitaire', x: 300, y: 100, width: 560, height: 500 },
    { id: '0x3', title: 'Terminal', x: 10, y: 10, width: 100, height: 100 },
  ];

  it('prefers an exact title, else titles containing the words', () => {
    expect(findWindows(windows, 'Terminal').map((w) => w.id)).toEqual(['0x3']);
    expect(findWindows(windows, 'solitaire').map((w) => w.id)).toEqual(['0x2']);
    expect(findWindows(windows, 'root@box').map((w) => w.id)).toEqual(['0x1']);
    expect(findWindows(windows, 'Mail')).toHaveLength(0);
  });
});
