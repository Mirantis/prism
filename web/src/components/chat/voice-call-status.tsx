import type { VoiceCallStatus as Status } from '@/hooks/use-voice-call';

/**
 * What a voice chat looks like from outside the audio: whether one is running, whether
 * the agent is speaking, and why the last one stopped.
 *
 * A call is written down nowhere, so this is the whole of it on screen. It says so in the
 * composer's own strip rather than in the transcript, where a line would read as a
 * message that never arrived.
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
