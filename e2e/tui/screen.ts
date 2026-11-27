/**
 * The terminal screen a PTY's output draws: the visible rows, after every cursor
 * move and erase. A test reads what a person sees from it, whatever sequence of
 * writes the TUI used to get there.
 *
 * It handles what a line-based TUI writes: printable text with wide and zero-width
 * characters, CR, LF, backspace, cursor moves, line and screen erases, and it skips
 * colour, OSC, APC and DCS sequences. The scrollback is not kept.
 */

const ESC = '\x1b';

function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

export class Screen {
  private readonly rows: string[][];
  private x = 0;
  private y = 0;
  private wrapPending = false;
  /** An escape sequence split across two writes. */
  private pending = '';

  constructor(
    private readonly columns: number,
    private readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () => this.blankRow());
  }

  /** The visible rows, each without trailing spaces. */
  text(): string {
    return this.rows.map((row) => row.join('').trimEnd()).join('\n');
  }

  write(data: string): void {
    const input = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === ESC) {
        const end = this.escapeEnd(input, i);
        if (end === -1) {
          this.pending = input.slice(i);
          return;
        }
        this.escape(input.slice(i, end));
        i = end;
        continue;
      }
      const code = input.codePointAt(i)!;
      i += code > 0xffff ? 2 : 1;
      if (ch === '\r') {
        this.x = 0;
        this.wrapPending = false;
      } else if (ch === '\n') {
        this.lineFeed();
      } else if (ch === '\b') {
        this.x = Math.max(0, this.x - 1);
        this.wrapPending = false;
      } else {
        this.print(String.fromCodePoint(code), charWidth(code));
      }
    }
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => ' ');
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.y === this.height - 1) {
      this.rows.shift();
      this.rows.push(this.blankRow());
    } else {
      this.y += 1;
    }
  }

  private print(text: string, width: number): void {
    if (width === 0) {
      const at = Math.max(0, this.x - 1);
      this.rows[this.y]![at] += text;
      return;
    }
    if (this.wrapPending || this.x + width > this.columns) {
      this.x = 0;
      this.lineFeed();
    }
    const row = this.rows[this.y]!;
    row[this.x] = text;
    if (width === 2 && this.x + 1 < this.columns) row[this.x + 1] = '';
    this.x += width;
    if (this.x >= this.columns) {
      this.x = this.columns - 1;
      this.wrapPending = true;
    }
  }

  /** The index after the escape sequence at `start`, or -1 when it is not complete yet. */
  private escapeEnd(input: string, start: number): number {
    const kind = input[start + 1];
    if (kind === undefined) return -1;
    if (kind === '[') {
      for (let i = start + 2; i < input.length; i++) {
        const c = input.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) return i + 1;
      }
      return -1;
    }
    if (kind === ']' || kind === '_' || kind === 'P') {
      for (let i = start + 2; i < input.length; i++) {
        if (input[i] === '\x07') return i + 1;
        if (input[i] === ESC) {
          if (i + 1 >= input.length) return -1;
          if (input[i + 1] === '\\') return i + 2;
        }
      }
      return -1;
    }
    return start + 2;
  }

  private escape(sequence: string): void {
    if (sequence[1] !== '[') return;
    const final = sequence[sequence.length - 1];
    const body = sequence.slice(2, -1);
    if (body.startsWith('?') || body.startsWith('>')) return;
    const params = body.split(';').map((p) => (p === '' ? NaN : Number(p)));
    const n = Number.isNaN(params[0]!) ? 1 : params[0]!;
    switch (final) {
      case 'A':
        this.y = Math.max(0, this.y - n);
        break;
      case 'B':
        this.y = Math.min(this.height - 1, this.y + n);
        break;
      case 'C':
        this.x = Math.min(this.columns - 1, this.x + n);
        break;
      case 'D':
        this.x = Math.max(0, this.x - n);
        break;
      case 'G':
        this.x = Math.min(this.columns - 1, n - 1);
        break;
      case 'H':
      case 'f':
        this.y = Math.min(this.height - 1, (Number.isNaN(params[0]!) ? 1 : params[0]!) - 1);
        this.x = Math.min(this.columns - 1, (Number.isNaN(params[1] ?? NaN) ? 1 : params[1]!) - 1);
        break;
      case 'J': {
        const mode = Number.isNaN(params[0]!) ? 0 : params[0]!;
        if (mode === 0) {
          this.rows[this.y]!.fill(' ', this.x);
          for (let r = this.y + 1; r < this.height; r++) this.rows[r] = this.blankRow();
        } else if (mode === 2 || mode === 3) {
          for (let r = 0; r < this.height; r++) this.rows[r] = this.blankRow();
        }
        break;
      }
      case 'K': {
        const mode = Number.isNaN(params[0]!) ? 0 : params[0]!;
        if (mode === 0) this.rows[this.y]!.fill(' ', this.x);
        else if (mode === 2) this.rows[this.y] = this.blankRow();
        break;
      }
      default:
        return;
    }
    this.wrapPending = false;
  }
}
