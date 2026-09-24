import { useEffect, useRef, useState } from 'react';
import { AudioLines, Bot, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { VoiceCall } from '@/hooks/use-voice-call';
import ElapsedTime from './elapsed-time';

/**
 * A call in progress, at the top of the conversation it was placed from: who is on the
 * other end, for how long, whether they are speaking or listening, and the two controls a
 * call needs — mute and hang up. Nothing when there is no call.
 */
export default function VoiceCallBar({ call, agentName }: { call: VoiceCall; agentName: string }) {
  const { status } = call;

  // When the call became audible, for the timer. From `live` rather than the press, so it
  // counts time somebody could hear rather than time spent connecting.
  const [liveSince, setLiveSince] = useState<number | null>(null);
  useEffect(() => {
    setLiveSince(status === 'live' ? Date.now() : null);
  }, [status]);

  // The header's call button goes away as the call connects, so a keyboard user's focus
  // lands here, on the control that ends it — unless they already moved it themselves.
  const endRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (status !== 'idle' && document.activeElement === document.body) endRef.current?.focus();
  }, [status]);

  if (status === 'idle') return null;
  const isLive = status === 'live';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3" data-testid="voice-call-bar">
      <div
        className="flex items-center gap-3 rounded-2xl border border-green-500/25 bg-green-500/10 py-2 pr-2 pl-2.5"
        // Present only on a live call, which is what the page's own tests wait for.
        data-testid={isLive ? 'voice-call-indicator' : undefined}
      >
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-background/60 text-green-500 transition-shadow ${
            call.isSpeaking ? 'ring-2 ring-green-500/60' : 'ring-0'
          }`}
          aria-hidden="true"
        >
          <Bot className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {isLive ? `On a call with ${agentName}` : `Calling ${agentName}…`}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {isLive && liveSince !== null && <ElapsedTime startedAt={liveSince} />}
            {isLive && <span aria-hidden="true">·</span>}
            {!isLive ? (
              <span>Connecting</span>
            ) : call.isMuted ? (
              <span className="text-destructive">You're muted</span>
            ) : call.isSpeaking ? (
              <span className="flex items-center gap-1 text-green-500" data-testid="voice-call-speaking">
                <AudioLines className="size-3.5 animate-pulse" aria-hidden="true" />
                Speaking
              </span>
            ) : (
              <span>Listening</span>
            )}
          </p>
        </div>

        {isLive && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`size-9 rounded-full ${
              call.isMuted
                ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                : 'bg-background/60 hover:bg-background'
            }`}
            onClick={call.toggleMute}
            title={call.isMuted ? 'Unmute your microphone' : 'Mute your microphone'}
            aria-label={call.isMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={call.isMuted}
            data-testid="voice-mute-button"
          >
            {call.isMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </Button>
        )}
        <Button
          ref={endRef}
          type="button"
          size="icon"
          className="size-9 rounded-full bg-destructive text-white hover:bg-destructive/90"
          onClick={call.stop}
          title={isLive ? 'End the call' : 'Cancel the call'}
          aria-label={isLive ? 'End voice call' : 'Cancel voice call'}
          data-testid="voice-call-end"
        >
          <PhoneOff className="size-4" />
        </Button>
      </div>
    </div>
  );
}
