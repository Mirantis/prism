import type { VoiceCallStatus as Status } from '@/hooks/use-voice-call';

/**
 * Whether a voice chat is running, whether the agent is speaking, and why the last call
 * stopped. Rendered in the composer's strip, not in the transcript: a call adds no
 * message to the thread.
 */
export default function VoiceCallStatus({
  status,
  isSpeaking,
  error,
}: {
  status: Status;
  isSpeaking: boolean;
  error: string | null;
}) {
  if (status === 'idle' && !error) return null;

  return (
    <span className="flex items-center gap-2">
      {status !== 'idle' && (
        <span data-testid="voice-call-indicator" className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-green-500" />
          {status === 'live' ? 'Voice chat live' : 'Starting the voice chat…'}
          {isSpeaking && (
            <span data-testid="voice-call-speaking" className="text-foreground">
              — the agent is speaking
            </span>
          )}
        </span>
      )}
      {error && (
        <span data-testid="voice-call-error" role="status" className="text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
