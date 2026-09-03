/**
 * The user's hand on the desktop: pointer, buttons, wheel and keys sent by the page while
 * it holds the pointer lock, turned into X input on the virtual display.
 *
 * One long-lived `xdotool -` reads commands from stdin, one per line, so a stream of mouse
 * movement costs a line each rather than a process each. Movement arrives as deltas: the
 * page has no cursor of its own while locked, so the position lives here, clamped to the
 * screen, and is flushed a few dozen times a second. Buttons and keys go straight through
 * on the same stream, behind any movement already queued, so a click lands where the
 * pointer was last put.
 *
 * Keys arrive as the browser names them (`KeyboardEvent.key` plus modifier flags) and
 * leave as X keysyms: a printable character is its own keysym, or a Unicode one, so the
 * layout of the page's keyboard does not matter; a named key is mapped; a modifier alone
 * is ignored, since it reaches the display as part of the chord it modifies.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';

export type InputFrame =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'pointer_move'; dx: number; dy: number }
  | { type: 'pointer_button'; button: 'left' | 'middle' | 'right'; down: boolean }
  | { type: 'wheel'; dy: number }
  | { type: 'key'; key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

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

/**
 * The `xdotool key` argument for a key event, or null for a modifier alone or a key with no
 * keysym. A printable character already carries its own shift (an `A`, an `!`), so shift is
 * spelled out only for a named key, where "shift+Tab" and "Tab" are different keys.
 */
export function chordFor(frame: Extract<InputFrame, { type: 'key' }>): string | null {
  if (MODIFIER_KEYS.has(frame.key) || frame.key === 'Escape') return null;
  const keysym = keysymFor(frame.key);
  if (!keysym) return null;
  const named = Array.from(frame.key).length !== 1;
  const parts = [
    frame.ctrl ? 'ctrl' : null,
    frame.alt ? 'alt' : null,
    frame.meta ? 'super' : null,
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

  /** `env` is the display's; `width` and `height` its geometry in pixels. */
  constructor(
    private readonly env: Record<string, string>,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.x = Math.floor(width / 2);
    this.y = Math.floor(height / 2);
  }

  handle(frame: InputFrame): void {
    if (this.stopped) return;
    switch (frame.type) {
      case 'pointer':
        this.place(frame.x, frame.y);
        this.flushMove();
        return;
      case 'pointer_move':
        this.place(this.x + frame.dx, this.y + frame.dy);
        this.scheduleMove();
        return;
      case 'pointer_button':
        this.flushMove();
        this.write(`${frame.down ? 'mousedown' : 'mouseup'} ${BUTTONS[frame.button] ?? '1'}`);
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
    }
  }

  private place(x: number, y: number): void {
    this.x = Math.min(this.width - 1, Math.max(0, Math.round(x)));
    this.y = Math.min(this.height - 1, Math.max(0, Math.round(y)));
  }

  private scheduleMove(): void {
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.write(`mousemove ${this.x} ${this.y}`);
    }, MOVE_FLUSH_MS);
  }

  private flushMove(): void {
    if (!this.moveTimer) return;
    clearTimeout(this.moveTimer);
    this.moveTimer = null;
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

  /** Release the pointer and the process. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
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
