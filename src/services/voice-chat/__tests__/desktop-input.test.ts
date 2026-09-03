import { describe, expect, it } from 'vitest';
import { chordFor, keysymFor } from '../desktop-input';

const key = (
  k: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
) => ({ type: 'key' as const, key: k, ctrl: false, alt: false, shift: false, meta: false, ...mods });

describe('keysymFor', () => {
  it('passes letters and digits through, case intact', () => {
    expect(keysymFor('a')).toBe('a');
    expect(keysymFor('A')).toBe('A');
    expect(keysymFor('7')).toBe('7');
  });

  it('names ASCII punctuation and the space', () => {
    expect(keysymFor('!')).toBe('exclam');
    expect(keysymFor('/')).toBe('slash');
    expect(keysymFor(' ')).toBe('space');
  });

  it('spells any other printable character as a Unicode keysym', () => {
    expect(keysymFor('ä')).toBe('U00E4');
    expect(keysymFor('€')).toBe('U20AC');
  });

  it('maps the browser names of the editing and arrow keys', () => {
    expect(keysymFor('Enter')).toBe('Return');
    expect(keysymFor('Backspace')).toBe('BackSpace');
    expect(keysymFor('ArrowLeft')).toBe('Left');
    expect(keysymFor('PageDown')).toBe('Next');
    expect(keysymFor('F5')).toBe('F5');
  });

  it('has nothing for a key the display cannot take', () => {
    expect(keysymFor('Unidentified')).toBeNull();
    expect(keysymFor('Dead')).toBeNull();
  });
});

describe('chordFor', () => {
  it('sends a plain character on its own', () => {
    expect(chordFor(key('x'))).toBe('x');
  });

  it('prefixes the modifiers the browser reported', () => {
    expect(chordFor(key('c', { ctrl: true }))).toBe('ctrl+c');
    expect(chordFor(key('F4', { alt: true }))).toBe('alt+F4');
    expect(chordFor(key('l', { ctrl: true, meta: true }))).toBe('ctrl+super+l');
  });

  it('spells shift out for a named key only, since a character carries its own', () => {
    expect(chordFor(key('Tab', { shift: true }))).toBe('shift+Tab');
    expect(chordFor(key('A', { shift: true }))).toBe('A');
    expect(chordFor(key('!', { shift: true }))).toBe('exclam');
  });

  it('ignores a modifier pressed on its own, and Escape', () => {
    expect(chordFor(key('Shift', { shift: true }))).toBeNull();
    expect(chordFor(key('Control', { ctrl: true }))).toBeNull();
    expect(chordFor(key('Escape'))).toBeNull();
  });
});
