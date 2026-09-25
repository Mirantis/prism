import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalInputParser, type TerminalInput } from './input.js';

const ESC = '\x1b';
const graphics = (params: string, data = '') => `${ESC}_G${params};${data}${ESC}\\`;

export interface TerminalSize {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export class KittyTerminal extends EventEmitter {
  private parser = new TerminalInputParser((input) => this.receive(input));
  private originalRaw = process.stdin.isRaw;
  private cellWidth = 10;
  private cellHeight = 20;
  private active = false;
  private imageId = 2;
  private frameDirectory?: string;
  private fileTransfer = false;
  private pointerShape = 'default';
  private legacyPointer = process.env.TERM_PROGRAM === 'iTerm.app';
  private onReadable = () => {
    let chunk: Buffer | string | null;
    while ((chunk = process.stdin.read()) !== null) {
      this.parser.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  };
  private onResize = () => {
    process.stdout.write(`${ESC}[14t${ESC}[16t`);
    this.emit('resize');
  };

  static async open(): Promise<KittyTerminal | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
    // A multiplexer needs placement support as well as escape passthrough.
    if (process.env.TMUX || process.env.STY) return null;
    const terminal = new KittyTerminal();
    process.stdin.setRawMode(true);
    process.stdin.ref();
    process.stdin.on('readable', terminal.onReadable);
    const supported = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 700);
      terminal.once('support', (ok: boolean) => { clearTimeout(timer); resolve(ok); });
      process.stdout.write(graphics('a=q,i=1,s=1,v=1,f=24,t=d', 'AAAA') + `${ESC}[14t${ESC}[16t`);
    });
    if (!supported) {
      await terminal.close();
      return null;
    }
    terminal.active = true;
    process.stdout.write(`${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h${ESC}[>1u`);
    process.stdout.write(`${ESC}]22;${terminal.legacyPointer ? 'left_ptr' : '>default'}${ESC}\\`);
    process.stdout.on('resize', terminal.onResize);
    try {
      terminal.frameDirectory = await mkdtemp(path.join(os.tmpdir(), 'prism-terminal-'));
      const probe = path.join(terminal.frameDirectory, 'probe.rgb');
      await writeFile(probe, Buffer.alloc(3));
      terminal.fileTransfer = await terminal.graphicsReply(4,
        graphics('a=q,i=4,s=1,v=1,f=24,t=f', Buffer.from(probe).toString('base64')), 700) === 'OK';
    } catch (error) {
      await terminal.close();
      throw error;
    }
    return terminal;
  }

  get size(): TerminalSize {
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    return { columns, rows, width: Math.round(columns * this.cellWidth), height: Math.round(rows * this.cellHeight) };
  }

  async frame(png: string): Promise<void> {
    const previous = this.imageId;
    this.imageId = previous === 2 ? 3 : 2;
    const { columns, rows } = this.size;
    let output = '';
    if (this.fileTransfer) {
      // The terminal confirms each read before either of the two files is reused.
      const file = path.join(this.frameDirectory!, `${this.imageId}.png`);
      await writeFile(file, Buffer.from(png, 'base64'));
      const reply = await this.graphicsReply(this.imageId,
        graphics(`a=t,t=f,f=100,i=${this.imageId}`, Buffer.from(file).toString('base64')), 5000);
      if (reply !== 'OK') throw new Error(`The terminal could not read a browser frame: ${reply || 'no reply'}.`);
    } else for (let offset = 0; offset < png.length; offset += 4096) {
      const more = offset + 4096 < png.length ? 1 : 0;
      const params = offset === 0 ? `a=t,t=d,f=100,i=${this.imageId},q=2,m=${more}` : `m=${more},q=2`;
      output += graphics(params, png.slice(offset, offset + 4096));
    }
    output += `${ESC}[?2026h${ESC}[H` + graphics(`a=p,i=${this.imageId},c=${columns},r=${rows},C=1,q=2`)
      + graphics(`a=d,d=I,i=${previous},q=2`) + `${ESC}[?2026l`;
    await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  }

  pointer(shape: string): void {
    // CSS cursors can contain URLs; only protocol shape names may enter an OSC.
    if (!/^[a-z-]+$/.test(shape) || shape === 'auto' || shape === 'none') shape = 'default';
    if (shape === this.pointerShape) return;
    this.pointerShape = shape;
    const legacy: Record<string, string> = { default: 'left_ptr', pointer: 'hand2', text: 'xterm',
      'ew-resize': 'sb_h_double_arrow', 'ns-resize': 'sb_v_double_arrow', move: 'fleur', wait: 'watch' };
    process.stdout.write(`${ESC}]22;${this.legacyPointer ? legacy[shape] ?? 'left_ptr' : shape}${ESC}\\`);
  }

  async close(): Promise<void> {
    process.stdout.off('resize', this.onResize);
    process.stdin.off('readable', this.onReadable);
    this.parser.dispose();
    if (this.active) {
      process.stdout.write(graphics('a=d,d=I,i=2,q=2') + graphics('a=d,d=I,i=3,q=2')
        + `${ESC}]22;${this.legacyPointer ? 'xterm' : '<'}${ESC}\\`
        + `${ESC}[<u${ESC}[?1003l${ESC}[?1006l${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`);
      this.active = false;
    }
    process.stdin.setRawMode(this.originalRaw ?? false);
    process.stdin.unref();
    this.removeAllListeners();
    if (this.frameDirectory) await rm(this.frameDirectory, { recursive: true, force: true });
  }

  private graphicsReply(id: number, command: string, timeout: number): Promise<string> {
    return new Promise((resolve) => {
      const event = `graphics:${id}`;
      const finish = (reply: string) => { clearTimeout(timer); this.off(event, finish); resolve(reply); };
      const timer = setTimeout(() => finish(''), timeout);
      this.once(event, finish);
      process.stdout.write(command);
    });
  }

  private receive(input: TerminalInput): void {
    if (input.type === 'graphics') {
      if (input.response.startsWith('Gi=1;')) this.emit('support', input.response === 'Gi=1;OK');
      const match = /^Gi=(\d+);(.*)$/.exec(input.response);
      if (match) this.emit(`graphics:${match[1]}`, match[2]);
      return;
    }
    if (input.type === 'size') {
      if (input.width <= 0 || input.height <= 0) return;
      this.cellWidth = input.width / (input.kind === 4 ? this.size.columns : 1);
      this.cellHeight = input.height / (input.kind === 4 ? this.size.rows : 1);
      this.emit('resize');
      return;
    }
    this.emit('input', input);
  }
}
