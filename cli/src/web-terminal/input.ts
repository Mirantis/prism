/* eslint-disable no-control-regex -- Terminal input includes control bytes. */
import { StringDecoder } from 'node:string_decoder';

export type TerminalInput =
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; modifiers: number }
  | { type: 'mouse'; button: number; x: number; y: number; release: boolean }
  | { type: 'size'; kind: number; width: number; height: number }
  | { type: 'graphics'; response: string };

const arrows: Record<string, string> = {
  A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End',
};
const tildeKeys: Record<number, string> = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown',
  7: 'Home', 8: 'End', 11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5',
  17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12',
};
const codeKeys: Record<number, string> = { 9: 'Tab', 13: 'Enter', 27: 'Escape', 127: 'Backspace' };

/** Parse complete terminal sequences across arbitrary UTF-8 and PTY chunks. */
export class TerminalInputParser {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private paste = false;
  private escapeTimer?: ReturnType<typeof setTimeout>;

  constructor(private emit: (input: TerminalInput) => void) {}

  feed(data: Buffer): void {
    clearTimeout(this.escapeTimer);
    this.buffer += this.decoder.write(data);
    while (this.buffer) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) return;
        this.emit({ type: 'text', text: this.buffer.slice(0, end) });
        this.buffer = this.buffer.slice(end + 6);
        this.paste = false;
        continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) {
        this.buffer = this.buffer.slice(6);
        this.paste = true;
        continue;
      }
      if (this.buffer === '\x1b') {
        this.escapeTimer = setTimeout(() => {
          this.buffer = '';
          this.key('Escape');
        }, 40);
        return;
      }
      if (this.buffer.startsWith('\x1b_')) {
        const end = this.buffer.indexOf('\x1b\\');
        if (end < 0) return;
        this.emit({ type: 'graphics', response: this.buffer.slice(2, end) });
        this.buffer = this.buffer.slice(end + 2);
        continue;
      }
      if (this.buffer.startsWith('\x1b[')) {
        const match = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(this.buffer);
        if (!match) return;
        this.buffer = this.buffer.slice(match[0].length);
        this.csi(match[1]!, match[3]!);
        continue;
      }
      if (this.buffer.startsWith('\x1bO')) {
        if (this.buffer.length < 3) return;
        const code = this.buffer[2]!;
        this.buffer = this.buffer.slice(3);
        const key = arrows[code] ?? ({ P: 'F1', Q: 'F2', R: 'F3', S: 'F4' } as Record<string, string>)[code];
        if (key) this.key(key);
        continue;
      }
      if (this.buffer[0] === '\x1b') {
        const char = String.fromCodePoint(this.buffer.codePointAt(1)!);
        this.buffer = this.buffer.slice(1 + char.length);
        this.key(char, 2);
        continue;
      }
      const text = /^[^\x00-\x1f\x7f]+/.exec(this.buffer)?.[0];
      if (text) {
        this.buffer = this.buffer.slice(text.length);
        this.emit({ type: 'text', text });
        continue;
      }
      const code = this.buffer.charCodeAt(0);
      this.buffer = this.buffer.slice(1);
      if (codeKeys[code]) this.key(codeKeys[code]!);
      else if (code === 10) this.key('Enter', 1);
      else if (code > 0 && code < 27) this.key(String.fromCharCode(96 + code), 4);
    }
  }

  dispose(): void { clearTimeout(this.escapeTimer); }

  private key(key: string, modifiers = 0): void {
    this.emit({ type: 'key', key, modifiers });
  }

  private csi(params: string, final: string): void {
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const [button, x, y] = params.slice(1).split(';').map(Number);
      this.emit({ type: 'mouse', button: button!, x: x!, y: y!, release: final === 'm' });
      return;
    }
    const [code = 0, modifier = 1, third = 0] = params.split(';').map(Number);
    if (final === 't' && (code === 4 || code === 6)) {
      this.emit({ type: 'size', kind: code, height: modifier, width: third });
      return;
    }
    if (arrows[final]) this.key(arrows[final]!, modifier - 1);
    else if (final === 'Z') this.key('Tab', 1);
    else if (final === '~' && tildeKeys[code]) this.key(tildeKeys[code]!, modifier - 1);
    else if (final === 'u') {
      // Kitty modifiers use shift=1, alt=2, ctrl=4, super=8, plus one.
      const fields = params.split(';');
      const point = Number(fields[0]!.split(':')[0]);
      const mods = Number((fields[1] ?? '1').split(':')[0]) - 1;
      if (point <= 0x10ffff) this.key(codeKeys[point] ?? String.fromCodePoint(point), mods);
    }
  }
}
