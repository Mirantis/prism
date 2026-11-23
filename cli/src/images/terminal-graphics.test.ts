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
      cell: { width: 10, height: 20 },
      terminal: 'kitty(0.36.4)',
      complete: true,
      rest: '',
    });
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
