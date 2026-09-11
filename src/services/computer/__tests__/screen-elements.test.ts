import { describe, expect, it } from 'vitest';
import { describeElements, findElements, type ScreenElement } from '../screen-elements';
import { findWindows, type DesktopWindow } from '../desktop-windows';

// What the tree dump produced on the desktop with a terminal open and the About dialog in
// front of it.
const ELEMENTS: ScreenElement[] = [
  { app: 'xfce4-panel', role: 'toggle button', name: 'Applications', x: 0, y: 0, width: 116, height: 26 },
  { app: 'xfce4-panel', role: 'toggle button', name: 'Terminal - node@box: /app', x: 124, y: 0, width: 200, height: 26 },
  { app: 'xfce4-panel', role: 'toggle button', name: 'About the Xfce Desktop Environment', x: 324, y: 0, width: 200, height: 26 },
  { app: 'xfce4-terminal', role: 'frame', name: 'Terminal - node@box: /app', x: 0, y: 27, width: 823, height: 524 },
  { app: 'xfce4-terminal', role: 'menu', name: 'File', x: 5, y: 64, width: 48, height: 24 },
  { app: 'xfce4-terminal', role: 'menu', name: 'Edit', x: 53, y: 64, width: 48, height: 24 },
  { app: 'xfce4-about', role: 'dialog', name: 'About the Xfce Desktop Environment', x: 610, y: 27, width: 670, height: 636 },
  { app: 'xfce4-about', role: 'page tab', name: 'System', x: 642, y: 81, width: 48, height: 24 },
  { app: 'xfce4-about', role: 'page tab', name: 'About', x: 716, y: 81, width: 40, height: 24 },
  { app: 'xfce4-about', role: 'page tab', name: 'Credits', x: 782, y: 81, width: 56, height: 24 },
  { app: 'xfce4-about', role: 'page tab', name: 'Debian', x: 864, y: 81, width: 48, height: 24 },
  { app: 'xfce4-about', role: 'label', name: 'Distributor', x: 797, y: 198, width: 112, height: 17 },
  { app: 'xfce4-about', role: 'label', name: 'Debian', x: 921, y: 198, width: 336, height: 17 },
  { app: 'xfce4-about', role: 'push button', name: 'Close', x: 1184, y: 617, width: 86, height: 36 },
];

describe('findElements', () => {
  it('finds a control by its whole name, ignoring case and punctuation', () => {
    const [found] = findElements(ELEMENTS, 'credits');
    expect(found.name).toBe('Credits');
    expect(findElements(ELEMENTS, 'Close.')).toHaveLength(1);
  });

  it('prefers a whole-name match over names that merely contain the query', () => {
    const found = findElements(ELEMENTS, 'About');
    expect(found.map((e) => e.name)).toEqual(['About']);
    expect(found[0].role).toBe('page tab');
  });

  it('falls back to names containing the query', () => {
    expect(findElements(ELEMENTS, 'Credit').map((e) => e.name)).toEqual(['Credits']);
  });

  it('never returns a plain label, which is not a target', () => {
    expect(findElements(ELEMENTS, 'Debian').map((e) => e.role)).toEqual(['page tab']);
    expect(findElements(ELEMENTS, 'Distributor')).toHaveLength(0);
  });

  it('answers empty for a name that is not there', () => {
    expect(findElements(ELEMENTS, 'Web Browser')).toHaveLength(0);
  });
});

describe('describeElements', () => {
  it('groups controls by program with their centres, windows first', () => {
    const text = describeElements(ELEMENTS);
    expect(text).toContain('xfce4-about:');
    expect(text).toContain('page tab "Credits" at (810, 93)');
    const terminal = text.slice(text.indexOf('xfce4-terminal:'));
    expect(terminal.indexOf('frame "Terminal')).toBeLessThan(terminal.indexOf('menu "File"'));
    expect(text).not.toContain('label "Distributor"');
  });

  it('filters by name and says when nothing matches', () => {
    expect(describeElements(ELEMENTS, 'credit')).toContain('page tab "Credits"');
    expect(describeElements(ELEMENTS, 'credit')).not.toContain('Applications');
    expect(describeElements(ELEMENTS, 'nothing here')).toContain('No control named like');
  });
});

describe('findWindows', () => {
  const windows: DesktopWindow[] = [
    { id: '0x1', title: 'Terminal - node@box: /app', x: 4, y: 95, width: 819, height: 488 },
    { id: '0x2', title: 'About the Xfce Desktop Environment', x: 614, y: 95, width: 666, height: 600 },
    { id: '0x3', title: 'Terminal', x: 384, y: 328, width: 619, height: 298 },
  ];

  it('prefers an exact title, else titles containing the words', () => {
    expect(findWindows(windows, 'Terminal').map((w) => w.id)).toEqual(['0x3']);
    expect(findWindows(windows, 'xfce').map((w) => w.id)).toEqual(['0x2']);
    expect(findWindows(windows, 'node@box').map((w) => w.id)).toEqual(['0x1']);
    expect(findWindows(windows, 'Mail')).toHaveLength(0);
  });
});
