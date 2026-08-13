/**
 * What the log has to guarantee is not "it stores the conversation" — that part is
 * trivial — but that the bytes a delegation re-sends are the same bytes as last time.
 * Every test here is about that: sealed chunks never change, growth lands in the open
 * tail, and the cap drops whole chunks instead of rewriting them.
 */

import { describe, it, expect } from 'vitest';
import {
  createTranscriptLog,
  TRANSCRIPT_CHUNK_CHARS,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_OMISSION_MARKER,
} from '../call-transcript';

/** A line of a known length, so a test can seal a chunk in a predictable number. */
const line = (n: number, chars = 100) => `${String(n).padStart(4, '0')} ${'x'.repeat(chars)}`;

describe('createTranscriptLog', () => {
  it('starts empty, with nothing sealed and nothing open', () => {
    const log = createTranscriptLog();

    expect(log.chunks()).toEqual({ sealed: '', open: '' });
    expect(log.stats()).toEqual({
      lines: 0,
      chars: 0,
      sealedChars: 0,
      openChars: 0,
      droppedChunks: 0,
    });
  });

  it('labels the room and the agent, one line each', () => {
    const log = createTranscriptLog();

    log.append('can you check the staging cluster');
    log.append('two pods are crashlooping', 'agent');

    expect(log.chunks().open).toBe('Room: can you check the staging cluster\nYou: two pods are crashlooping');
    expect(log.stats().lines).toBe(2);
  });

  it('ignores an utterance that trims to nothing', () => {
    // A transcription can come back empty or as whitespace, and an empty labeled line
    // is worse than no line: it is a byte change that buys nothing.
    const log = createTranscriptLog();

    log.append('   ');
    log.append('\n\t');

    expect(log.chunks().open).toBe('');
    expect(log.stats().lines).toBe(0);
  });

  it('trims the utterance itself, so trailing whitespace cannot change a chunk', () => {
    const log = createTranscriptLog();

    log.append('  hello there  ');

    expect(log.chunks().open).toBe('Room: hello there');
  });

  it('keeps everything in the open tail until the seal threshold is reached', () => {
    const log = createTranscriptLog({ chunkChars: 500 });

    log.append(line(1)); // ~105 chars
    log.append(line(2));

    expect(log.chunks().sealed).toBe('');
    expect(log.chunks().open.split('\n')).toHaveLength(2);
  });

  it('seals the open tail into a chunk once it passes the threshold', () => {
    const log = createTranscriptLog({ chunkChars: 300 });

    log.append(line(1));
    log.append(line(2));
    log.append(line(3)); // ~317 chars with newlines — over the threshold

    const { sealed, open } = log.chunks();
    expect(sealed.split('\n')).toHaveLength(3);
    expect(sealed).toContain('0001');
    expect(sealed).toContain('0003');
    // Sealing empties the tail; the next utterance starts a new one.
    expect(open).toBe('');
  });

  it('never changes a sealed chunk when more is said', () => {
    // The whole point: between seals the cached prefix is byte-identical, so the
    // provider can read it instead of re-processing it.
    const log = createTranscriptLog({ chunkChars: 300 });

    log.append(line(1));
    log.append(line(2));
    log.append(line(3));
    const afterSeal = log.chunks().sealed;

    log.append(line(4));
    log.append(line(5));

    expect(log.chunks().sealed).toBe(afterSeal);
    expect(log.chunks().open).toContain('0005');
  });

  it('grows the sealed part only in whole chunks', () => {
    const log = createTranscriptLog({ chunkChars: 300 });

    const sealedSizes = new Set<number>();
    for (let i = 1; i <= 30; i++) {
      log.append(line(i));
      sealedSizes.add(log.chunks().sealed.length);
    }

    // Thirty ~105-char lines against a 300-char quantum: ten seals at most, and each
    // distinct size is one seal. Far fewer distinct sizes than appends is the property.
    expect(sealedSizes.size).toBeLessThanOrEqual(11);
    expect(sealedSizes.size).toBeGreaterThan(1);
  });

  it('drops the oldest whole chunk when the cap is passed, and says so once', () => {
    const log = createTranscriptLog({ chunkChars: 300, maxChars: 900 });

    for (let i = 1; i <= 40; i++) log.append(line(i));

    const { sealed } = log.chunks();
    expect(log.stats().droppedChunks).toBeGreaterThan(0);
    expect(sealed).toContain(TRANSCRIPT_OMISSION_MARKER);
    // The marker appears once, at the front, and is fixed text — a marker that counted
    // its drops would invalidate the prefix again on every drop.
    expect(sealed.indexOf(TRANSCRIPT_OMISSION_MARKER)).toBe(0);
    expect(sealed.split(TRANSCRIPT_OMISSION_MARKER)).toHaveLength(2);
    // The oldest lines are gone and the newest survive.
    expect(sealed).not.toContain('0001 ');
    expect(sealed + log.chunks().open).toContain('0040 ');
  });

  it('holds the sealed part under the cap while dropping', () => {
    const log = createTranscriptLog({ chunkChars: 300, maxChars: 900 });

    for (let i = 1; i <= 60; i++) log.append(line(i));

    expect(log.stats().sealedChars).toBeLessThanOrEqual(900 + TRANSCRIPT_OMISSION_MARKER.length + 1);
  });

  it('keeps one chunk even when a single chunk exceeds the cap', () => {
    // A cap smaller than a quantum must not empty the transcript — the delegate would
    // then be handed a marker and nothing else, which is worse than an over-long prompt.
    const log = createTranscriptLog({ chunkChars: 300, maxChars: 100 });

    for (let i = 1; i <= 12; i++) log.append(line(i));

    expect(log.chunks().sealed).not.toBe('');
    expect(log.stats().droppedChunks).toBeGreaterThan(0);
  });

  it('counts what it holds, for telemetry, and nothing more', () => {
    const log = createTranscriptLog({ chunkChars: 300 });

    log.append(line(1));
    log.append(line(2));
    log.append(line(3));
    log.append(line(4));

    const stats = log.stats();
    expect(stats.lines).toBe(4);
    expect(stats.sealedChars).toBe(log.chunks().sealed.length);
    expect(stats.openChars).toBeGreaterThan(0);
    expect(stats.chars).toBe(stats.sealedChars + stats.openChars);
  });

  it('defaults to quanta well above a model minimum and a cap that fits a context window', () => {
    // Both are the reason the design works rather than incidental numbers: the quantum
    // has to clear the smallest cacheable prefix, and the cap has to leave the delegate
    // room for its own tool output.
    expect(TRANSCRIPT_CHUNK_CHARS).toBe(4_000);
    expect(TRANSCRIPT_MAX_CHARS).toBe(40_000);

    const log = createTranscriptLog();
    for (let i = 1; i <= 20; i++) log.append(line(i));

    // Twenty ~105-char lines is nowhere near the default quantum, so nothing is sealed.
    expect(log.chunks().sealed).toBe('');
    expect(log.chunks().open.split('\n')).toHaveLength(20);
  });
});
