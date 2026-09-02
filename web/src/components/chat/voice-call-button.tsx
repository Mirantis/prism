import { Mic, PhoneOff } from 'lucide-react';
import { InputGroupButton } from '@/components/ui/input-group';
import type { VoiceCallStatus } from '@/hooks/use-voice-call';

/**
 * The one control for a voice chat: it starts a call, and while one runs it ends it.
 *
 * It sits in the composer beside the attach button, where a call is a way of saying
 * something rather than a page of its own.
 */
export default function VoiceCallButton({
  status,
  disabled,
  onStart,
  onStop,
}: {
  status: VoiceCallStatus;
  /** The socket is down, so a call cannot be started or ended. */
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const isRunning = status !== 'idle';
  const label = isRunning ? 'End voice chat' : 'Voice chat';

  return (
    <InputGroupButton
      type="button"
      size="icon-xs"
      variant={isRunning ? 'default' : 'ghost'}
      disabled={disabled}
      onClick={isRunning ? onStop : onStart}
      title={disabled ? 'Not connected' : label}
      aria-label={label}
      data-testid="voice-call-button"
      className={isRunning ? 'rounded-full' : undefined}
    >
      {isRunning ? <PhoneOff className="size-3.5" /> : <Mic className="size-3.5" />}
    </InputGroupButton>
  );
}
