import { describe, it, expect } from 'vitest';
import { programStatusSequence } from './program-status.js';

const OSC = '\x1b]7501;';
const ST = '\x1b\\';

/** The specification's grammar for the pairs of a report. */
const PAIRS = /^[a-z]+=[A-Za-z0-9_.,+/=-]*(:[a-z]+=[A-Za-z0-9_.,+/=-]*)*$/;

/** True when the text is one report: OSC 7501, valid pairs, ST. */
const isReport = (text: string): boolean =>
  text.startsWith(OSC) && text.endsWith(ST) && PAIRS.test(text.slice(OSC.length, -ST.length));

const msgOf = (sequence: string): Buffer =>
  Buffer.from(/msg=([A-Za-z0-9+/=]*)/.exec(sequence)![1]!, 'base64');

describe('programStatusSequence', () => {
  it('writes the states without a message as bare pairs', () => {
    expect(programStatusSequence({ state: 'idle' })).toBe('\x1b]7501;state=idle:app=prism\x1b\\');
    expect(programStatusSequence({ state: 'clear' })).toBe('\x1b]7501;state=clear\x1b\\');
  });

  it('writes the kind and the message as base64 of UTF-8', () => {
    const sequence = programStatusSequence({ state: 'blocked', kind: 'auth', msg: 'Sign in to café.example' });
    expect(sequence).toBe(
      `\x1b]7501;state=blocked:kind=auth:app=prism:msg=${Buffer.from('Sign in to café.example').toString('base64')}\x1b\\`,
    );
    expect(isReport(sequence)).toBe(true);
  });

  it('turns every control character in the message into a space', () => {
    const sequence = programStatusSequence({ state: 'error', msg: 'line one\nline\ttwo\u0085\u007f.' });
    expect(msgOf(sequence).toString('utf8')).toBe('line one line two  .');
  });

  it('cuts a long message on a whole character, inside the specification limits', () => {
    // 2000 characters, the most a sign-in reason may have, at three bytes each.
    const sequence = programStatusSequence({ state: 'blocked', kind: 'auth', msg: '€'.repeat(2000) });
    const msg = msgOf(sequence);
    expect(msg.length).toBe(2046);
    expect(msg.toString('utf8')).toBe('€'.repeat(682));
    expect(Buffer.byteLength(sequence)).toBeLessThanOrEqual(4096);
    expect(isReport(sequence)).toBe(true);
  });
});
