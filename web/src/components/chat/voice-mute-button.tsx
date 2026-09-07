import { Mic, MicOff } from 'lucide-react';
import { InputGroupButton } from '@/components/ui/input-group';

/**
 * Mute the microphone during a call, and open it again. Shown only while a call runs,
 * beside the control that ends it.
 */
export default function VoiceMuteButton({
  isMuted,
  onToggle,
}: {
  isMuted: boolean;
  onToggle: () => void;
}) {
  const label = isMuted ? 'Unmute microphone' : 'Mute microphone';

  return (
    <InputGroupButton
      type="button"
      size="icon-xs"
      variant={isMuted ? 'destructive' : 'ghost'}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={isMuted}
      data-testid="voice-mute-button"
      className="rounded-full"
    >
      {isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
    </InputGroupButton>
  );
}
