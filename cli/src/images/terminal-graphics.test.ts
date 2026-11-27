import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  PROBE,
  detectTerminalGraphics,
  drawsPlaceholders,
  graphicsFrom,
  isLateProbeReply,
  parseProbeReplies,
} from './terminal-graphics.js';

// What kitty 0.36 answers to PROBE, in order.
const KITTY_REPLIES = '\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1bP>|kitty(0.36.4)\x1b\\\x1b[?62;c';
// What Rex 0.1.0-preview.23 answers to PROBE: no feature query support.
const REX_REPLIES =
  '\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;EINVAL: dimensions required\x1b\\\x1b[6;16;8t\x1bP>|rex 0.1.0-preview.23\x1b\\\x1b[?62;22c';
// What Rio answers to PROBE, read from its source (rio-vt `report_version`,
// `identify_terminal`, `cells_size_pixels` and the kitty query decode): it
// ignores the feature query's `e` key and fails the image-less query.
const RIO_REPLIES =
  '\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;EINVAL: dimensions required\x1b\\\x1b[6;20;10t\x1bP>|Rio 0.5.32\x1b\\\x1b[?62;4;6;22;52c';
// What Konsole answers to PROBE, read from its source (Vt102Emulation.cpp): it
// answers OK to both graphics queries without echoing the feature query's keys.
const KONSOLE_REPLIES =
  '\x1b_Gi=31;OK\x1b\\\x1b_Gi=32;OK\x1b\\\x1b[6;17;8t\x1bP>|Konsole 25.08.3\x1b\\\x1b[?62;1;4c';
// kitty 0.50's answer to PROBE's feature query, as kitty's own test asserts for
// `a=q,i=31,e=T,U=1` (kitty_tests/graphics.py, `q('T', U=1)`).
const PLACEHOLDER_REPLY = '\x1b_Gi=32,e=T,U=1;OK\x1b\\';
// A terminal that knows none of the queries but the device attributes.
const PLAIN_REPLIES = '\x1b[?1;2c';

function fakeTerminal(answer: string | null) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream & PassThrough;
  const written: string[] = [];
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      written.push(chunk);
      if (answer !== null) setImmediate(() => stdin.write(answer));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stdin, stdout, written };
}

describe('parseProbeReplies', () => {
  it("reads kitty's answers", () => {
    expect(parseProbeReplies(KITTY_REPLIES)).toEqual({
      graphics: true,
      placeholders: false,
      cell: { width: 10, height: 20 },
      terminal: 'kitty(0.36.4)',
      complete: true,
      rest: '',
    });
  });

  it('reads the placeholder feature query answer', () => {
    expect(parseProbeReplies(`${PLACEHOLDER_REPLY}${PLAIN_REPLIES}`).placeholders).toBe(true);
    // The spec lets the keys come in any order.
    expect(parseProbeReplies('\x1b_GU=1,e=T,i=32;OK\x1b\\').placeholders).toBe(true);
    expect(parseProbeReplies('\x1b_Gi=32,e=T;OK\x1b\\').placeholders).toBe(false);
    expect(parseProbeReplies('\x1b_Gi=32;OK\x1b\\').placeholders).toBe(false);
    expect(parseProbeReplies(REX_REPLIES)).toMatchObject({ graphics: true, placeholders: false, rest: '' });
  });

  it('reads a graphics error as no graphics', () => {
    expect(parseProbeReplies('\x1b_Gi=31;EINVAL:bad\x1b\\\x1b[?62;c').graphics).toBe(false);
  });

  it('is incomplete until the device attributes arrive', () => {
    expect(parseProbeReplies('\x1b_Gi=31;OK\x1b\\').complete).toBe(false);
  });

  it('keeps what is not an answer', () => {
    expect(parseProbeReplies(`hi${PLAIN_REPLIES}!`).rest).toBe('hi!');
  });
});

describe('drawsPlaceholders', () => {
  it.each([
    ['kitty(0.36.4)', true],
    ['kitty(0.28.0)', true],
    ['kitty(0.27.1)', false],
    ['ghostty 1.1.3', true],
    ['Rio 0.5.30', true],
    ['Rio 0.3.11', true],
    ['Rio 0.3.10', false],
    ['rex 0.1.0-preview.23', true],
    ['Konsole 24.08.3', false],
    ['WezTerm 20240203-110809-5046fc22', false],
    [null, false],
  ])('%s → %s', (terminal, expected) => {
    expect(drawsPlaceholders(terminal)).toBe(expected);
  });
});

describe('graphicsFrom', () => {
  it('uses kitty graphics only where placeholders draw', () => {
    const replies = parseProbeReplies(KITTY_REPLIES);
    expect(graphicsFrom(replies)).toEqual({ protocol: 'kitty', cell: { width: 10, height: 20 } });
    expect(graphicsFrom({ ...replies, terminal: 'WezTerm 20240203' }).protocol).toBe('text');
  });

  it('uses kitty graphics in a terminal that reports placeholders, whatever its name', () => {
    const replies = parseProbeReplies(`\x1b_Gi=31;OK\x1b\\${PLACEHOLDER_REPLY}\x1bP>|NewTerm 1.0\x1b\\${PLAIN_REPLIES}`);
    expect(graphicsFrom(replies).protocol).toBe('kitty');
  });

  it('uses kitty graphics in Rex', () => {
    expect(graphicsFrom(parseProbeReplies(REX_REPLIES))).toEqual({ protocol: 'kitty', cell: { width: 8, height: 16 } });
  });

  it('uses kitty graphics in Rio from 0.3.11', () => {
    expect(graphicsFrom(parseProbeReplies(RIO_REPLIES)).protocol).toBe('kitty');
    expect(graphicsFrom(parseProbeReplies(RIO_REPLIES.replace('Rio 0.5.32', 'Rio 0.3.10'))).protocol).toBe('text');
  });

  it('keeps the description in Konsole, which answers OK to the feature query without its keys', () => {
    expect(graphicsFrom(parseProbeReplies(KONSOLE_REPLIES))).toEqual({ protocol: 'text', cell: { width: 8, height: 17 } });
  });

  it('keeps the description in a terminal without kitty graphics', () => {
    expect(graphicsFrom(parseProbeReplies(PLAIN_REPLIES))).toEqual({ protocol: 'text', cell: null });
  });
});

describe('detectTerminalGraphics', () => {
  it('asks the terminal and reads its answers', async () => {
    const { stdin, stdout, written } = fakeTerminal(KITTY_REPLIES);
    const graphics = await detectTerminalGraphics(stdin, stdout, 1_000);
    expect(written).toEqual([PROBE]);
    expect(graphics.cell).toEqual({ width: 10, height: 20 });
  });

  it('gives up when the terminal does not answer', async () => {
    const { stdin, stdout } = fakeTerminal(null);
    const graphics = await detectTerminalGraphics(stdin, stdout, 20);
    expect(graphics).toEqual({ protocol: 'text', cell: null });
  });

  it('puts keys typed during the wait back for the app to read', async () => {
    const { stdin, stdout } = fakeTerminal(`x${PLAIN_REPLIES}`);
    await detectTerminalGraphics(stdin, stdout, 1_000);
    expect(String(stdin.read())).toBe('x');
  });

  it('waits longer for a terminal that has begun to answer by the deadline', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream & PassThrough;
    const stdout = {
      isTTY: true,
      write() {
        // The first answers arrive in time, the device attributes after the deadline.
        setImmediate(() => stdin.write('\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1bP>|kitty(0.36.4)\x1b\\\x1b[?6'));
        setTimeout(() => stdin.write('2;c'), 60);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const graphics = await detectTerminalGraphics(stdin, stdout, 20, 1_000);
    expect(graphics.protocol).toBe('kitty');
    expect(stdin.read()).toBeNull();
  });

  it('does not type an answer the wait ended in the middle of', async () => {
    const { stdin, stdout } = fakeTerminal('x\x1b[?62;');
    await detectTerminalGraphics(stdin, stdout, 20, 20);
    expect(String(stdin.read())).toBe('x');
  });
});

describe('isLateProbeReply', () => {
  it('knows the device attributes and the cell size as Ink passes them on', () => {
    expect(isLateProbeReply('[?62;22c')).toBe(true);
    expect(isLateProbeReply('\x1b[?1;2c')).toBe(true);
    expect(isLateProbeReply('[6;20;10t')).toBe(true);
  });

  it('leaves typed text alone', () => {
    expect(isLateProbeReply('c')).toBe(false);
    expect(isLateProbeReply('[?]')).toBe(false);
    expect(isLateProbeReply('see [6] t')).toBe(false);
  });
});
