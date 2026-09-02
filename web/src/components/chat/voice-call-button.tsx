import { Mic, MicOff } from 'lucide-react';
import { InputGroupButton } from '@/components/ui/input-group';
import type { VoiceCallState } from '@/hooks/use-voice-call';

interface VoiceCallButtonProps {
  state: VoiceCallState;
  /** Signalling rides the chat socket, so a closed socket cannot start a call. */
  isConnected: boolean;
  onStart: () => void;
  onStop: () => void;
}

// The button is icon-only, so the label carries the whole explanation, the same way
// `sendLabel` does in ChatInput. None of these says "recording" or "transcribing":
// nothing about a call is written down, and a label that suggests otherwise would be
// the interface claiming a transcript exists.
const labels: Record<VoiceCallState, string> = {
  idle: 'Start a voice chat',
  starting: 'Starting a voice chat — allow your microphone',
  connecting: 'Connecting the voice chat…',
  live: 'End the voice chat',
  ending: 'Ending the voice chat…',
};

export default function VoiceCallButton({ state, isConnected, onStart, onStop }: VoiceCallButtonProps) {
  const inCall = state !== 'idle';
  return (
    <InputGroupButton
      type="button"
      size="icon-xs"
      variant={inCall ? 'default' : 'ghost'}
      disabled={!isConnected}
      onClick={inCall ? onStop : onStart}
      title={isConnected ? labels[state] : 'Not connected'}
      aria-label={isConnected ? labels[state] : 'Not connected'}
      data-testid="voice-call-button"
    >
      {inCall ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
    </InputGroupButton>
  );
}
