import { describe, expect, it, vi } from 'vitest';
import { TerminalInputParser, type TerminalInput } from './input.js';

describe('terminal browser input', () => {
  it('keeps UTF-8 text, mouse reports and paste intact across byte boundaries', () => {
    const events: TerminalInput[] = [];
    const parser = new TerminalInputParser((event) => events.push(event));
    const input = Buffer.from('猫\x1b[<0;15;8M\x1b[200~hello\nworld\x1b[201~\x1b[13;2u');
    for (const byte of input) parser.feed(Buffer.from([byte]));
    expect(events).toEqual([
      { type: 'text', text: '猫' },
      { type: 'mouse', button: 0, x: 15, y: 8, release: false },
      { type: 'text', text: 'hello\nworld' },
      { type: 'key', key: 'Enter', modifiers: 1 },
    ]);
    parser.dispose();
  });

  it('separates capability replies from keystrokes', () => {
    const events: TerminalInput[] = [];
    const parser = new TerminalInputParser((event) => events.push(event));
    parser.feed(Buffer.from('\x1b_Gi=1;OK\x1b\\\x1b[4;800;1200t\x1b[?1;2c\x03'));
    expect(events).toEqual([
      { type: 'graphics', response: 'Gi=1;OK' },
      { type: 'size', kind: 4, width: 1200, height: 800 },
      { type: 'key', key: 'c', modifiers: 4 },
    ]);
  });

  it('distinguishes Escape from a fragmented arrow key', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const parser = new TerminalInputParser(emit);
    parser.feed(Buffer.from('\x1b'));
    parser.feed(Buffer.from('[D'));
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: 'key', key: 'ArrowLeft', modifiers: 0 });
    parser.feed(Buffer.from('\x1b'));
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenLastCalledWith({ type: 'key', key: 'Escape', modifiers: 0 });
    parser.dispose();
    vi.useRealTimers();
  });
});
