/**
 * Reading an H.264 byte stream well enough to send it a frame at a time.
 *
 * The encoder writes one long stream of NAL units, each behind a start code of three or
 * four bytes. A picture is an access unit, which is several NALs together, and the encoder
 * is asked to put a delimiter NAL in front of each one, so a delimiter is where a picture
 * begins. That is the only structure the runtime needs: it forwards whole pictures and
 * lets the browser decode them.
 */

/** The five bits of a NAL's header byte that say what it is. */
const NAL_DELIMITER = 9;
const NAL_IDR = 5;
const NAL_SPS = 7;

export interface AccessUnits {
  /** Whole pictures, in order. */
  units: Buffer[];
  /** The bytes after the last whole picture, to be read with what comes next. */
  rest: Buffer;
}

/** Where each NAL's header byte is, and what kind it is. */
function* nals(data: Buffer): Generator<{ at: number; kind: number }> {
  // A start code is 00 00 01, with an extra 00 allowed in front of it.
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const header = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1;
    if (header === -1 || header >= data.length) continue;
    yield { at: header, kind: data[header] & 0x1f };
    i = header;
  }
}

/**
 * Split what has arrived into whole pictures.
 *
 * A picture is only whole once the next one has started, so the last delimiter and
 * everything after it stays in `rest` until more bytes arrive.
 */
export function splitAccessUnits(data: Buffer): AccessUnits {
  const starts: number[] = [];
  for (const { at, kind } of nals(data)) {
    if (kind !== NAL_DELIMITER) continue;
    // The picture starts at its start code, not at the header byte inside it.
    starts.push(data[at - 4] === 0 && data[at - 3] === 0 && data[at - 2] === 0 ? at - 4 : at - 3);
  }
  if (starts.length < 2) return { units: [], rest: data };
  const units: Buffer[] = [];
  for (let i = 0; i + 1 < starts.length; i++) units.push(data.subarray(starts[i], starts[i + 1]));
  return { units, rest: data.subarray(starts[starts.length - 1]) };
}

/** Whether this picture can be decoded on its own, which is where a viewer can join. */
export function isKeyframe(unit: Buffer): boolean {
  for (const { kind } of nals(unit)) if (kind === NAL_IDR) return true;
  return false;
}

/**
 * The name the browser knows this stream by, read off its parameter set: the profile, the
 * constraints on it and the level, as the three bytes after the NAL header.
 */
export function codecFrom(unit: Buffer): string | null {
  for (const { at, kind } of nals(unit)) {
    if (kind !== NAL_SPS || at + 3 >= unit.length) continue;
    const hex = [unit[at + 1], unit[at + 2], unit[at + 3]]
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join('');
    return `avc1.${hex}`;
  }
  return null;
}
