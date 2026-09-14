import { describe, expect, it } from 'vitest';
import { DesktopInput, MAX_PASTE_CHARS, chordFor, inputFrame, keysymFor, pasteText } from '../desktop-input';

const key = (
  k: string,
  mods: Partial<{ code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
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
    expect(chordFor(key('2', { alt: true, code: 'Digit2' }))).toBe('alt+2');
    expect(chordFor(key('f', { alt: true, code: 'KeyF' }))).toBe('alt+f');
  });

  it('sends Cmd as Ctrl, the key the desktop binds copy and paste to', () => {
    expect(chordFor(key('c', { meta: true, code: 'KeyC' }))).toBe('ctrl+c');
    expect(chordFor(key('l', { ctrl: true, meta: true }))).toBe('ctrl+l');
  });

  it('drops the Alt that typed a character, as Option does on a Mac', () => {
    // Option+2 is @ on a Finnish keyboard; the browser reports @ with Alt held.
    expect(chordFor(key('@', { alt: true, code: 'Digit2' }))).toBe('at');
    expect(chordFor(key('ƒ', { alt: true, code: 'KeyF' }))).toBe('U0192');
    expect(chordFor(key('@', { alt: true }))).toBe('at');
    expect(chordFor(key('f', { alt: true }))).toBe('alt+f');
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

describe('pasteText', () => {
  it('types a text as it is, newlines included', () => {
    expect(pasteText('kubectl get pods\n-n kube-system')).toBe('kubectl get pods\n-n kube-system');
  });

  it('cuts a paste at the limit, on a character boundary', () => {
    const long = '€'.repeat(MAX_PASTE_CHARS + 5);
    expect(Array.from(pasteText(long))).toHaveLength(MAX_PASTE_CHARS);
  });
});

describe('the pointer on a screen that changes size', () => {
  // The screen is the object `DesktopControl` keeps, and the client resizes it mid-chat.
  const screen = { width: 1280, height: 720 };
  const input = new DesktopInput({}, screen);

  it('keeps the pointer inside the screen it is on', () => {
    input.handle({ type: 'pointer_move', dx: 9999, dy: 9999 });
    expect(input.pointer).toEqual({ x: 1279, y: 719 });
  });

  it('lets the pointer reach the far corner of a screen that grew', () => {
    screen.width = 1920;
    screen.height = 1080;
    input.handle({ type: 'pointer_move', dx: 9999, dy: 9999 });
    expect(input.pointer).toEqual({ x: 1919, y: 1079 });
    input.stop();
  });
});

describe('inputFrame', () => {
  it('reads each frame the page sends', () => {
    expect(inputFrame({ type: 'pointer', x: 4, y: 9 })).toEqual({ type: 'pointer', x: 4, y: 9 });
    expect(inputFrame({ type: 'pointer_move', dx: -2, dy: 3 })).toEqual({ type: 'pointer_move', dx: -2, dy: 3 });
    expect(inputFrame({ type: 'pointer_button', button: 'right', down: true })).toEqual({
      type: 'pointer_button',
      button: 'right',
      down: true,
    });
    expect(inputFrame({ type: 'wheel', dy: 120 })).toEqual({ type: 'wheel', dy: 120 });
    expect(inputFrame({ type: 'text', text: 'hello' })).toEqual({ type: 'text', text: 'hello' });
  });

  it('takes a key with its modifiers, and reads a missing modifier as up', () => {
    expect(inputFrame({ type: 'key', key: 'c', code: 'KeyC', ctrl: true })).toEqual({
      type: 'key', key: 'c', code: 'KeyC', ctrl: true, alt: false, shift: false, meta: false,
    });
  });

  it('drops a frame whose fields are not what its type needs', () => {
    // A key frame with no key used to reach `keysymFor`, which reads the key as characters
    // and threw out of the socket's message handler.
    expect(inputFrame({ type: 'key', ctrl: false })).toBeNull();
    expect(inputFrame({ type: 'key', key: 5 })).toBeNull();
    expect(inputFrame({ type: 'pointer', x: 4 })).toBeNull();
    expect(inputFrame({ type: 'pointer', x: '4', y: '9' })).toBeNull();
    expect(inputFrame({ type: 'pointer_move', dx: Number.NaN, dy: 0 })).toBeNull();
    expect(inputFrame({ type: 'pointer_button', button: 'fourth', down: true })).toBeNull();
    expect(inputFrame({ type: 'pointer_button', button: 'left' })).toBeNull();
    expect(inputFrame({ type: 'wheel', dy: null })).toBeNull();
    expect(inputFrame({ type: 'text' })).toBeNull();
  });

  it('drops anything that is not a frame at all', () => {
    expect(inputFrame({ type: 'orbit', x: 1, y: 1 })).toBeNull();
    expect(inputFrame({})).toBeNull();
    expect(inputFrame(null)).toBeNull();
    expect(inputFrame('key')).toBeNull();
    expect(inputFrame(7)).toBeNull();
  });
});

describe('a malformed frame reaching the display', () => {
  it('is dropped at the door rather than read as input', () => {
    const input = new DesktopInput({}, { width: 1280, height: 720 });
    const before = input.pointer;
    expect(() => input.handle({ type: 'key', ctrl: false, alt: false })).not.toThrow();
    expect(() => input.handle({ type: 'pointer', x: 'far', y: 'down' })).not.toThrow();
    expect(input.pointer).toEqual(before);
    input.stop();
  });
});
