import { describe, it, expect } from 'vitest';
import { CLEAR_SEQUENCE, programStatusSequence } from './program-status';

const OSC = '\x1b]7501;';
const ST = '\x1b\\';

/** The specification's grammar for the pairs of a report. */
const PAIRS = /^[a-z]+=[A-Za-z0-9_.,+/=-]*(:[a-z]+=[A-Za-z0-9_.,+/=-]*)*$/;

/** True when the text is one report: OSC 7501, valid pairs, ST. */
const isReport = (text: string): boolean =>
  text.startsWith(OSC) && text.endsWith(ST) && PAIRS.test(text.slice(OSC.length, -ST.length));

const decoded = (sequence: string, key: string): Buffer =>
  Buffer.from(new RegExp(`${key}=([A-Za-z0-9+/=]*)`).exec(sequence)![1]!, 'base64');

const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('programStatusSequence', () => {
  it('names the program and the title in every report', () => {
    expect(programStatusSequence({ state: 'idle' }, 'Peter')).toBe(
      `\x1b]7501;state=idle:app=prism:title=${base64('Peter')}\x1b\\`,
    );
    expect(CLEAR_SEQUENCE).toBe('\x1b]7501;state=clear\x1b\\');
  });

  it('writes the kind and the message as base64 of UTF-8', () => {
    const sequence = programStatusSequence(
      { state: 'blocked', kind: 'question', msg: 'Accept the café terms?' },
      'Peter',
    );
    expect(sequence).toBe(
      `\x1b]7501;state=blocked:kind=question:app=prism:title=${base64('Peter')}:msg=${base64('Accept the café terms?')}\x1b\\`,
    );
    expect(isReport(sequence)).toBe(true);
  });

  it('turns every control character in the message into a space', () => {
    const sequence = programStatusSequence({ state: 'error', msg: 'line one\nline\ttwo\u0085\u007f.' }, 'Peter');
    expect(decoded(sequence, 'msg').toString('utf8')).toBe('line one line two  .');
  });

  it('cuts a long message and a long title on a whole character, inside the specification limits', () => {
    // 64 characters, the longest agent name, at four bytes each.
    const sequence = programStatusSequence(
      { state: 'blocked', kind: 'auth', msg: '€'.repeat(2000) },
      '😀'.repeat(64),
    );
    expect(decoded(sequence, 'msg').toString('utf8')).toBe('€'.repeat(682));
    expect(decoded(sequence, 'title').toString('utf8')).toBe('😀'.repeat(48));
    expect(Buffer.byteLength(sequence)).toBeLessThanOrEqual(4096);
    expect(isReport(sequence)).toBe(true);
  });
});
