/**
 * How loud a frame of pcm16 is, 0 to 1, on the scale a waveform draws.
 *
 * Through decibels, because hearing is logarithmic: a linear scale spends most of its
 * height on levels nobody can hear and leaves speech pinned to the bottom. Quieter than
 * -50 dBFS draws as silence, which leaves room below normal speech at about -30.
 */
const FLOOR_DB = -50;

export function audioLevel(frame: ArrayBuffer): number {
  const samples = new Int16Array(frame, 0, Math.floor(frame.byteLength / 2));
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const amplitude = Math.sqrt(sum / samples.length) / 32_768;
  if (amplitude === 0) return 0;
  const db = 20 * Math.log10(amplitude);
  if (db <= FLOOR_DB) return 0;
  return Math.min(1, db / -FLOOR_DB + 1);
}
