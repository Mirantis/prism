import { useEffect, useRef, useState } from 'react';
import { Loader2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { VoiceCall } from '@/hooks/use-voice-call';

/**
 * The chat header's call button: a round phone that places a call, and while the call
 * connects, the spinner that takes it back.
 *
 * A call that is live is shown by `VoiceCallBar` at the top of the conversation, so the
 * header holds no second copy of its controls. `blockedReason` is why a call cannot start
 * right now. It sits on a wrapper, because a disabled button takes no pointer events and
 * would never show a tooltip of its own.
 */
export default function VoiceCallControl({
  call,
  blockedReason,
}: {
  call: VoiceCall;
  blockedReason: string | null;
}) {
  const { status } = call;
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Spoken once per change of state, from here because this control is on screen for the
  // whole of a call. The timer stays out of it, or it would be read out every second. A
  // call that stops with an error says why, which is also the case of one that never
  // connected.
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef(status);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was === status) return;
    if (status === 'live') setAnnouncement('Call connected');
    else if (status === 'idle') {
      setAnnouncement(call.error ? `Call ended: ${call.error}` : 'Call ended');
      // The control that was pressed is gone, so give focus back to the one that places
      // the next call — unless the user has already moved it somewhere of their own.
      if (document.activeElement === document.body) buttonRef.current?.focus();
    }
  }, [status, call.error]);

  const isStarting = status === 'starting';
  if (status === 'live') {
    return (
      <span role="status" className="sr-only">
        {announcement}
      </span>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {!isStarting && call.error && (
        <span
          data-testid="voice-call-error"
          className="max-w-40 truncate text-xs text-destructive sm:max-w-72"
          title={call.error}
        >
          {call.error}
        </span>
      )}

      <span className="inline-flex" title={isStarting ? 'Cancel the call' : (blockedReason ?? 'Start a voice call')}>
        {/* One button for placing and cancelling, so focus stays on it while the call
            connects. */}
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon"
          className={`size-9 rounded-full ${isStarting ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={isStarting ? call.stop : call.start}
          disabled={!isStarting && blockedReason !== null}
          aria-label={isStarting ? 'Cancel voice call' : 'Start voice call'}
          aria-description={!isStarting && blockedReason ? blockedReason : undefined}
          data-testid={isStarting ? 'voice-call-cancel' : 'voice-call-button'}
        >
          {isStarting ? (
            <Loader2 className="size-[18px] animate-spin" />
          ) : (
            <Phone className="size-[18px]" />
          )}
        </Button>
      </span>
    </div>
  );
}
