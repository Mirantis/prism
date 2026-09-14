import { describe, expect, it } from 'vitest';
import { codecFrom, isKeyframe, splitAccessUnits } from '../h264';

/** A NAL of `kind`, behind a start code of the length the encoder really varies. */
function nal(kind: number, body: number[] = [0x00], short = false): Buffer {
  const start = short ? [0x00, 0x00, 0x01] : [0x00, 0x00, 0x00, 0x01];
  return Buffer.from([...start, kind, ...body]);
}

const DELIMITER = nal(9, [0xf0]);
/** The first three bytes of a parameter set are the profile, its constraints and the level. */
const SPS = nal(7, [0x64, 0x00, 0x1f, 0xac]);
const PPS = nal(8, [0xeb, 0xe2]);
const IDR = nal(5, [0x88, 0x84, 0x00]);
const SLICE = nal(1, [0x9a, 0x12], true);

describe('splitAccessUnits', () => {
  it('cuts the stream where each picture begins, and keeps the last one back', () => {
    const first = Buffer.concat([DELIMITER, SPS, PPS, IDR]);
    const second = Buffer.concat([DELIMITER, SLICE]);
    const third = Buffer.concat([DELIMITER, SLICE]);

    const { units, rest } = splitAccessUnits(Buffer.concat([first, second, third]));

    // A picture is only whole once the next one has started.
    expect(units).toHaveLength(2);
    expect(units[0].equals(first)).toBe(true);
    expect(units[1].equals(second)).toBe(true);
    expect(rest.equals(third)).toBe(true);
  });

  it('loses nothing when the bytes arrive in pieces of any size', () => {
    const stream = Buffer.concat([
      DELIMITER, SPS, PPS, IDR,
      DELIMITER, SLICE,
      DELIMITER, SLICE,
      DELIMITER, SLICE,
    ]);

    for (const size of [1, 3, 5, 64]) {
      let pending = Buffer.alloc(0);
      const seen: Buffer[] = [];
      for (let i = 0; i < stream.length; i += size) {
        pending = Buffer.concat([pending, stream.subarray(i, i + size)]);
        const out = splitAccessUnits(pending);
        seen.push(...out.units);
        pending = Buffer.from(out.rest);
      }
      expect(seen).toHaveLength(3);
      expect(Buffer.concat([...seen, pending]).equals(stream)).toBe(true);
    }
  });

  it('holds everything back until a second picture has begun', () => {
    const { units, rest } = splitAccessUnits(Buffer.concat([DELIMITER, SPS, PPS, IDR]));
    expect(units).toHaveLength(0);
    expect(rest).toHaveLength(DELIMITER.length + SPS.length + PPS.length + IDR.length);
  });
});

describe('isKeyframe', () => {
  it('is true for a picture a viewer can join on', () => {
    expect(isKeyframe(Buffer.concat([DELIMITER, SPS, PPS, IDR]))).toBe(true);
  });

  it('is false for one that needs the picture before it', () => {
    expect(isKeyframe(Buffer.concat([DELIMITER, SLICE]))).toBe(false);
  });
});

describe('codecFrom', () => {
  it('names the stream from its parameter set', () => {
    // What the encoder in the image really produced for a 1280x720 screen.
    expect(codecFrom(Buffer.concat([DELIMITER, SPS, PPS, IDR]))).toBe('avc1.64001F');
  });

  it('has no name until a parameter set arrives', () => {
    expect(codecFrom(Buffer.concat([DELIMITER, SLICE]))).toBeNull();
  });
});
