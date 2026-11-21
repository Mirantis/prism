import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { kittyPlaceholderLines, kittyTransmit } from './kitty.js';

describe('kittyTransmit', () => {
  it('sends the pixels compressed, in chunks of at most 4096 bytes', () => {
    // Random bytes do not compress, so the payload needs several chunks.
    const data = new Uint8Array(64 * 64 * 4).map(() => Math.floor(Math.random() * 256));
    const out = kittyTransmit({ width: 64, height: 64, data }, 0x123456, 8, 4);
    const chunks = [...out.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]![1]).toBe(`a=T,U=1,i=${0x123456},c=8,r=4,f=32,s=64,v=64,o=z,q=2,m=1`);
    expect(chunks.slice(1, -1).every((c) => c[1] === 'q=2,m=1')).toBe(true);
    expect(chunks.at(-1)![1]).toBe('q=2,m=0');
    expect(chunks.every((c) => c[2]!.length <= 4096)).toBe(true);
    const payload = Buffer.from(chunks.map((c) => c[2]).join(''), 'base64');
    expect(new Uint8Array(inflateSync(payload))).toEqual(data);
  });
});

describe('kittyPlaceholderLines', () => {
  it('colors each row with the id and names the row on its first cell', () => {
    const lines = kittyPlaceholderLines(0x123456, 3, 2);
    expect(lines).toEqual([
      '\x1b[38;2;18;52;86m\u{10EEEE}\u0305\u0305\u{10EEEE}\u{10EEEE}\x1b[39m',
      '\x1b[38;2;18;52;86m\u{10EEEE}\u030D\u0305\u{10EEEE}\u{10EEEE}\x1b[39m',
    ]);
  });
});
