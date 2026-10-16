/**
 * The user's hand on the desktop: pointer, buttons, wheel and keys sent by the page while
 * it holds the pointer lock, turned into X input on the virtual display.
 *
 * One long-lived `xdotool -` reads commands from stdin, one per line, so a stream of mouse
 * movement costs a line each rather than a process each. Movement arrives as deltas: the
 * page has no cursor of its own while locked, so the position lives here, clamped to the
 * screen it is given, and is flushed a few dozen times a second. Buttons and keys go
 * straight through on the same stream, behind any movement already queued, so a click
 * lands where the pointer was last put.
 *
 * Keys arrive as the browser names them (`KeyboardEvent.key` and `code`, plus modifier
 * flags) and leave as X keysyms: a printable character is its own keysym, or a Unicode
 * one, so the layout of the page's keyboard does not matter; a named key is mapped; a
 * modifier alone is ignored, since it reaches the display as part of the chord it
 * modifies. A text pasted on the page is typed out, character by character, into whatever
 * has focus on the desktop.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';

export type InputFrame =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'pointer_move'; dx: number; dy: number }
  | { type: 'pointer_button'; button: 'left' | 'middle' | 'right'; down: boolean }
  | { type: 'wheel'; dy: number }
  | { type: 'key'; key: string; code?: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
  | { type: 'text'; text: string };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isButton(value: unknown): value is 'left' | 'middle' | 'right' {
  return value === 'left' || value === 'middle' || value === 'right';
}

/**
 * A frame the page sent, read as input for the display, or null for anything else.
 *
 * The page's JSON arrives over a socket, so a frame's `type` says what it claims to be
 * and nothing more: each field the display needs is checked here. `handle` is the only
 * way in and it starts with this, so a frame missing a key or a coordinate is dropped at
 * the door rather than reaching code that reads it as a string or a number.
 */
export function inputFrame(value: unknown): InputFrame | null {
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'pointer':
      return finite(frame.x) && finite(frame.y) ? { type: 'pointer', x: frame.x, y: frame.y } : null;
    case 'pointer_move':
      return finite(frame.dx) && finite(frame.dy)
        ? { type: 'pointer_move', dx: frame.dx, dy: frame.dy }
        : null;
    case 'pointer_button':
      return isButton(frame.button) && typeof frame.down === 'boolean'
        ? { type: 'pointer_button', button: frame.button, down: frame.down }
        : null;
    case 'wheel':
      return finite(frame.dy) ? { type: 'wheel', dy: frame.dy } : null;
    case 'key':
      return typeof frame.key === 'string'
        ? {
            type: 'key',
            key: frame.key,
            code: typeof frame.code === 'string' ? frame.code : undefined,
            ctrl: frame.ctrl === true,
            alt: frame.alt === true,
            shift: frame.shift === true,
            meta: frame.meta === true,
          }
        : null;
    case 'text':
      return typeof frame.text === 'string' ? { type: 'text', text: frame.text } : null;
    default:
      return null;
  }
}

/**
 * The most a paste types. xdotool types about eighty characters a second, so this is two
 * minutes of typing; a longer paste is cut, not refused, since the start is usually what
 * was wanted.
 */
export const MAX_PASTE_CHARS = 10_000;

/** The part of a pasted text that gets typed. */
export function pasteText(text: string): string {
  return Array.from(text).slice(0, MAX_PASTE_CHARS).join('');
}

/** How long movement is gathered before one `mousemove` goes out. */
const MOVE_FLUSH_MS = 16;
/** Wheel pixels per wheel click, so a flick is a few clicks and not fifty. */
const WHEEL_PIXELS_PER_CLICK = 60;
const MAX_WHEEL_CLICKS = 10;

/** X11 button numbers: 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down. */
const BUTTONS = { left: '1', middle: '2', right: '3' } as const;

/** Browser key names with a different X keysym. */
const NAMED_KEYS: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  CapsLock: 'Caps_Lock',
  ContextMenu: 'Menu',
  ' ': 'space',
};

/** ASCII punctuation by keysym name; anything else printable goes as a Unicode keysym. */
const PUNCTUATION: Record<string, string> = {
  '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', $: 'dollar', '%': 'percent',
  '&': 'ampersand', "'": 'apostrophe', '(': 'parenleft', ')': 'parenright', '*': 'asterisk',
  '+': 'plus', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', ':': 'colon',
  ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at',
  '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum',
  _: 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright',
  '~': 'asciitilde',
};

/** Keys that are modifiers on their own; the page's other keys carry them as flags. */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/** The X keysym for a browser key name, or null for one that has no place on the display. */
export function keysymFor(key: string): string | null {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  const chars = Array.from(key);
  if (chars.length !== 1) return null;
  if (/^[A-Za-z0-9]$/.test(key)) return key;
  if (PUNCTUATION[key]) return PUNCTUATION[key];
  return `U${(key.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The character a physical key types on its own, for the `KeyboardEvent.code` values that name one. */
const BASE_CHARACTERS: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<', Space: ' ',
};

function baseCharacterFor(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return BASE_CHARACTERS[code] ?? null;
}

/**
 * Whether Alt was part of typing this character rather than a modifier on it. On a Mac the
 * Option key is how a layout reaches its second set of characters — `@` is Option+2 on a
 * Finnish keyboard — and the browser then reports the character with the Alt flag set. The
 * physical key tells the two apart: when the key's own character is not the one reported,
 * the Alt produced it. Without the physical key, a letter or digit keeps its Alt and any
 * other character drops it.
 */
function altTypedCharacter(frame: Extract<InputFrame, { type: 'key' }>): boolean {
  if (!frame.alt || Array.from(frame.key).length !== 1) return false;
  const base = baseCharacterFor(frame.code);
  if (base === null) return !/^[A-Za-z0-9]$/.test(frame.key);
  return frame.key.toLowerCase() !== base;
}

/**
 * The `xdotool key` argument for a key event, or null for a modifier alone or a key with no
 * keysym. A printable character already carries its own shift (an `A`, an `!`), so shift is
 * spelled out only for a named key, where "shift+Tab" and "Tab" are different keys. Cmd on
 * a Mac goes out as Ctrl: it is the key a Mac user presses for copy, paste and select-all,
 * which the desktop's applications bind to Ctrl, while Super, its literal counterpart, is
 * bound to nothing here and Chromium types the letter under it. A remote computer takes
 * `metaAs: 'super'`, since its own system binds Command or the Windows key itself.
 */
export function chordFor(
  frame: Extract<InputFrame, { type: 'key' }>,
  metaAs: 'ctrl' | 'super' = 'ctrl',
): string | null {
  if (MODIFIER_KEYS.has(frame.key) || frame.key === 'Escape') return null;
  const keysym = keysymFor(frame.key);
  if (!keysym) return null;
  const named = Array.from(frame.key).length !== 1;
  const parts = [
    frame.ctrl || (frame.meta && metaAs === 'ctrl') ? 'ctrl' : null,
    frame.meta && metaAs === 'super' ? 'super' : null,
    frame.alt && !altTypedCharacter(frame) ? 'alt' : null,
    frame.shift && named ? 'shift' : null,
    keysym,
  ];
  return parts.filter((p): p is string => p !== null).join('+');
}

export class DesktopInput {
  private proc: ChildProcess | null = null;
  private x: number;
  private y: number;
  private moveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Pastes run one at a time; this is the tail of that queue. */
  private typing: Promise<void> = Promise.resolve();
  /** The paste being typed right now, so that stopping the session stops it. */
  private typer: ChildProcess | null = null;

  /**
   * `env` is the display's. `screen` is read on every movement rather than copied, so the
   * pointer's bounds are the screen's own and follow it when the client resizes it.
   */
  constructor(
    private readonly env: Record<string, string>,
    private readonly screen: { readonly width: number; readonly height: number },
  ) {
    this.x = Math.floor(screen.width / 2);
    this.y = Math.floor(screen.height / 2);
  }

  /** Where the user's pointer is on the screen, in its pixels. */
  get pointer(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Act on a frame from the page. Takes it unread, since `inputFrame` is what reads it. */
  handle(value: unknown): void {
    if (this.stopped) return;
    const frame = inputFrame(value);
    if (!frame) return;
    switch (frame.type) {
      case 'pointer':
        this.place(frame.x, frame.y);
        // Written now rather than flushed: a flush only sends movement that is already
        // pending, and this frame is the pointer being put somewhere — the page sends it
        // when the user takes control, and a click can follow with nothing in between.
        this.moveNow();
        return;
      case 'pointer_move':
        this.place(this.x + frame.dx, this.y + frame.dy);
        this.scheduleMove();
        return;
      case 'pointer_button':
        this.flushMove();
        this.write(`${frame.down ? 'mousedown' : 'mouseup'} ${BUTTONS[frame.button]}`);
        return;
      case 'wheel': {
        const clicks = Math.min(MAX_WHEEL_CLICKS, Math.max(1, Math.round(Math.abs(frame.dy) / WHEEL_PIXELS_PER_CLICK)));
        this.flushMove();
        this.write(`click --repeat ${clicks} --delay 20 ${frame.dy > 0 ? '5' : '4'}`);
        return;
      }
      case 'key': {
        const chord = chordFor(frame);
        if (chord) this.write(`key ${chord}`);
        return;
      }
      case 'text':
        this.type(pasteText(frame.text));
        return;
    }
  }

  /**
   * Type a text into whatever has focus on the desktop, as a paste from the page does.
   *
   * A text is typed by its own `xdotool type`, fed through stdin: the command stream takes
   * a line per command, and a text has newlines of its own. Pastes queue behind each
   * other, since two typing at once interleave their characters, and the one running is
   * held so that ending the session ends it.
   */
  private type(text: string): void {
    if (!text) return;
    this.flushMove();
    this.typing = this.typing.then(() => this.runType(text));
  }

  private runType(text: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      // xdotool decodes the text through the locale, and the container has none set, under
      // which anything beyond ASCII is an invalid sequence to it.
      const proc = spawn('xdotool', ['type', '--file', '-'], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, ...this.env, LC_ALL: 'C.UTF-8' },
      });
      this.typer = proc;
      const done = (): void => {
        if (this.typer === proc) this.typer = null;
        resolve();
      };
      proc.on('error', (err) => {
        logger.warn({ err }, '[VoiceChat] Desktop typing process failed');
        done();
      });
      proc.on('exit', done);
      proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) logger.debug(`[VoiceChat:Input] ${line}`);
      });
      proc.stdin?.end(text);
    });
  }

  private place(x: number, y: number): void {
    this.x = Math.min(this.screen.width - 1, Math.max(0, Math.round(x)));
    this.y = Math.min(this.screen.height - 1, Math.max(0, Math.round(y)));
  }

  private scheduleMove(): void {
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.write(`mousemove ${this.x} ${this.y}`);
    }, MOVE_FLUSH_MS);
  }

  /** Send the movement waiting to go out, if any, so what follows lands where it should. */
  private flushMove(): void {
    if (!this.moveTimer) return;
    this.moveNow();
  }

  /** Put the pointer where it is now, dropping any movement still waiting on the timer. */
  private moveNow(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    this.write(`mousemove ${this.x} ${this.y}`);
  }

  private write(line: string): void {
    const proc = this.ensureProcess();
    proc?.stdin?.write(`${line}\n`);
  }

  private ensureProcess(): ChildProcess | null {
    if (this.proc) return this.proc;
    const proc = spawn('xdotool', ['-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, ...this.env },
    });
    proc.on('error', (err) => logger.warn({ err }, '[VoiceChat] Desktop input process failed'));
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) {
        if (!this.stopped) logger.warn(`[VoiceChat] Desktop input process exited (${signal ?? code})`);
        this.proc = null;
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug(`[VoiceChat:Input] ${line}`);
    });
    this.proc = proc;
    return proc;
  }

  /** Release the pointer and the processes. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    // A long paste types for as long as its text lasts, and the desktop it types into is
    // about to go.
    const typer = this.typer;
    this.typer = null;
    if (typer && typer.exitCode === null) typer.kill('SIGTERM');
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    proc.stdin?.end();
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
