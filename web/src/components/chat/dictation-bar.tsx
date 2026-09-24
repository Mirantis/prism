import { Loader2 } from 'lucide-react';
import type { Dictation } from '@/hooks/use-dictation';
import ElapsedTime from './elapsed-time';
import DictationWaveform from './dictation-waveform';

/** What a screen reader hears for each state. The timer is kept out of it on purpose. */
const SPOKEN: Record<Dictation['status'], string> = {
  idle: '',
  starting: 'Opening the microphone',
  recording: 'Recording',
  transcribing: 'Transcribing',
};

/**
 * What takes the text field's place while a dictation runs: the microphone's waveform
 * and the time recorded, then the wait for the words.
 */
export default function DictationBar({ dictation }: { dictation: Dictation }) {
  const { status } = dictation;

  return (
    <div
      className="flex min-h-[52px] w-full items-center gap-3 px-4 pt-3.5 pb-1"
      data-testid="dictation-bar"
      data-status={status}
    >
      {/* Announced once per state. A live region holding the timer would be read out
          every time the timer changes, for as long as the recording runs. */}
      <span role="status" className="sr-only">
        {SPOKEN[status]}
      </span>
      {status === 'recording' ? (
        <>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" aria-hidden="true">
            <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
            Recording
          </span>
          <DictationWaveform levels={dictation.levels} />
          {dictation.startedAt !== null && <ElapsedTime startedAt={dictation.startedAt} />}
        </>
      ) : (
        <span className="flex items-center gap-2 text-sm text-muted-foreground" aria-hidden="true">
          <Loader2 className="size-3.5 animate-spin" />
          {status === 'transcribing' ? 'Transcribing…' : 'Opening the microphone…'}
        </span>
      )}
    </div>
  );
}
