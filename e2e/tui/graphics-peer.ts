/* eslint-disable no-control-regex -- Terminal framing uses control bytes. */
import { readFileSync } from 'node:fs';
/** Kitty protocol peer; the CLI, Chromium and runtime run as real processes. */
export class GraphicsPeer {
  columns = 120;
  rows = 40;
  image?: Buffer;
  placements: { columns: number; rows: number }[] = [];
  pointer = '';
  files: string[] = [];
  sharedFiles = true;
  private buffer = '';
  private payload = '';
  private transmitting = false;

  receive = (data: string, reply: (data: string) => void): void => {
    this.buffer += data;
    while (this.buffer) {
      const start = this.buffer.indexOf('\x1b');
      if (start < 0) { this.buffer = ''; return; }
      this.buffer = this.buffer.slice(start);
      if (this.buffer.startsWith('\x1b]')) {
        const end = this.buffer.indexOf('\x1b\\');
        if (end < 0) return;
        const sequence = this.buffer.slice(2, end);
        if (sequence.startsWith('22;')) this.pointer = sequence.slice(3);
        this.buffer = this.buffer.slice(end + 2);
        continue;
      }
      if (this.buffer.startsWith('\x1b_G')) {
        const end = this.buffer.indexOf('\x1b\\');
        if (end < 0) return;
        const sequence = this.buffer.slice(3, end);
        this.buffer = this.buffer.slice(end + 2);
        const separator = sequence.indexOf(';');
        const params = Object.fromEntries(sequence.slice(0, separator).split(',').map((entry) => entry.split('=')));
        const payload = sequence.slice(separator + 1);
        if (params.a === 'q') {
          const supported = params.t !== 'f' || this.sharedFiles;
          if (params.t === 'f' && supported) readFileSync(Buffer.from(payload, 'base64').toString());
          reply(`\x1b_Gi=${params.i};${supported ? 'OK' : 'EBADF'}\x1b\\`);
        }
        if (params.a === 't' && params.t === 'f') {
          const file = Buffer.from(payload, 'base64').toString();
          this.files.push(file);
          this.image = readFileSync(file);
          reply(`\x1b_Gi=${params.i};OK\x1b\\`);
          continue;
        }
        if (params.a === 't') { this.payload = ''; this.transmitting = true; }
        if (this.transmitting) {
          this.payload += payload;
          if (params.m === '0') {
            this.image = Buffer.from(this.payload, 'base64');
            this.transmitting = false;
          }
        }
        if (params.a === 'p') this.placements.push({ columns: Number(params.c), rows: Number(params.r) });
        continue;
      }
      const csi = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/.exec(this.buffer)?.[0];
      if (!csi) return;
      this.buffer = this.buffer.slice(csi.length);
      if (csi === '\x1b[14t') reply(`\x1b[4;${this.rows * 20};${this.columns * 10}t`);
      if (csi === '\x1b[16t') reply('\x1b[6;20;10t');
    }
  };

  click(x: number, y: number): string {
    const column = Math.floor(x / 10) + 1;
    const row = Math.floor(y / 20) + 1;
    return `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`;
  }
}
