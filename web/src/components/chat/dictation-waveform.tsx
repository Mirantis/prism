/**
 * The microphone's level over the last few seconds, as a row of bars that scrolls.
 *
 * Drawn from the readings the dictation keeps, one per meter tick, so the shape is what
 * was heard a moment ago and a pause scrolls by as a flat stretch.
 */
export default function DictationWaveform({ levels }: { levels: number[] }) {
  return (
    // The newest reading on the right, and the oldest clipped at the left when the row is
    // narrower than the history.
    <div className="flex h-5 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" aria-hidden="true">
      {levels.map((sample, index) => (
        <span
          key={index}
          className="w-[3px] shrink-0 rounded-full bg-primary transition-[height] duration-100"
          // A floor rather than zero, so silence draws as a line and not as nothing.
          style={{ height: `${Math.max(12, Math.min(Math.max(sample, 0), 1) * 100)}%` }}
        />
      ))}
    </div>
  );
}
