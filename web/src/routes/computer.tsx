import { useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { useWebSocket } from '@/hooks/use-websocket';
import { useVoiceCall, type VoiceCall, type VoiceCallStatus } from '@/hooks/use-voice-call';
import { useComputerScreen, type Viewport } from '@/hooks/use-computer-screen';
import { useScreenShare } from '@/hooks/use-screen-share';
import { AgentTile } from '@/components/voice/agent-tile';
import { FrameStats, SCREEN_STATS_SHOWN } from '@/components/voice/frame-stats';
import { MuteButton } from '@/components/voice/mute-button';
import { ScreenView } from '@/components/voice/screen-view';
import { ShareButton } from '@/components/voice/share-button';
import { SharePreview } from '@/components/voice/share-preview';

export const Route = createFileRoute('/computer')({
  component: ComputerPage,
});

/** Connection status shown below the screen. */
const STATE_LABEL: Record<VoiceCallStatus, string> = {
  idle: 'Voice chat ended. Reload the page to start again.',
  starting: 'Connecting…',
  live: 'Live',
};

/**
 * The agent opens with this, since the user started the call by opening a page rather
 * than by pressing a button.
 */
const GREETING =
  'Your user just opened the voice chat in the web UI and can hear you. ' +
  'Greet them in one short sentence.';

/**
 * The rate this call speaks, both ways: the rate the agent's screen is recorded at, so
 * the sound of a video playing on that screen arrives unresampled.
 */
const SAMPLE_RATE = 48_000;

function ComputerPage() {
  const agent = useAgent();
  // The sidebar leaves this page out on a runtime with no desktop, so this is the
  // address bar or a stale link rather than a dead end the UI led them into.
  if (agent.hasComputer === false) return <NoComputer />;
  return <ComputerCall />;
}

function NoComputer() {
  return (
    <div className="mx-auto max-w-md space-y-2 py-16 text-center">
      <p className="text-sm font-medium text-zinc-200">This runtime has no computer</p>
      <p className="text-sm leading-6 text-muted-foreground">
        The agent's desktop needs packages the container image installs. Run the published
        image, or talk to the agent by voice from the chat page.
      </p>
    </div>
  );
}

function ComputerCall() {
  const agent = useAgent();
  // The agent's screen is made the size of the box below, so the call waits for the
  // first measurement of it.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const onViewport = useCallback((size: Viewport) => {
    setViewport((current) =>
      current && current.width === size.width && current.height === size.height ? current : size,
    );
  }, []);

  // The same socket, the same frames and the same controller the chat composer's call
  // uses; this one asks for a computer with it. The call is read through a ref because
  // the socket's handlers are bound before it exists, as they are on the chat page.
  const callRef = useRef<VoiceCall | null>(null);
  const ws = useWebSocket({
    onVoiceEvent: (event) => callRef.current?.handleEvent(event),
    onVoiceAudio: (frame) => callRef.current?.handleAudio(frame),
  });
  const call = useVoiceCall({
    sendVoiceStart: ws.sendVoiceStart,
    sendVoiceStop: ws.sendVoiceStop,
    sendVoiceAudio: ws.sendVoiceAudio,
    isConnected: ws.isConnected,
    request: viewport ? { computer: true, screen: viewport, greeting: GREETING } : undefined,
    sampleRate: SAMPLE_RATE,
    // Opening the page starts the call, and a microphone that is live before anyone
    // asked for it is a room being listened to.
    startMuted: true,
  });
  callRef.current = call;

  const live = call.status === 'live';
  const screen = useComputerScreen({
    enabled: live && call.hasDesktop,
    viewport,
    onAudio: call.handleComputerAudio,
  });
  const share = useScreenShare(screen.sendInput);

  // Opening the page is the gesture that starts the call, once the box has been measured.
  const { status, start } = call;
  useEffect(() => {
    if (status === 'idle' && viewport && ws.isConnected) start();
  }, [status, viewport, ws.isConnected, start]);

  // A share outlives the call that had a use for it: the browser goes on capturing the
  // user's screen, and the agent it was being shown to is gone. The button is disabled by
  // then, so nothing else would stop it.
  const { sharing, stop: stopSharing } = share;
  useEffect(() => {
    if (!live && sharing) stopSharing();
  }, [live, sharing, stopSharing]);

  const message = call.error ?? screen.message;

  return (
    <div className="space-y-4">
      <ScreenView
        screenRef={screen.screenRef}
        hasScreen={screen.hasScreen}
        controllable={call.hasDesktop && live}
        onInput={screen.sendInput}
        onViewport={onViewport}
        connecting={call.status !== 'idle'}
      >
        {screen.hasScreen && SCREEN_STATS_SHOWN && (
          <div className="absolute bottom-3 right-3">
            <FrameStats lastFrame={screen.lastFrame} />
          </div>
        )}
        {share.stream && (
          <div className="absolute left-3 top-3">
            <SharePreview stream={share.stream} />
          </div>
        )}
      </ScreenView>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <AgentTile name={agent.name} speaking={call.isSpeaking} connected={live} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <MuteButton muted={call.isMuted} disabled={!live} onToggle={call.toggleMute} />
          <ShareButton
            sharing={share.sharing}
            disabled={!live}
            onToggle={() => (share.sharing ? share.stop() : void share.start())}
          />
        </div>
      </div>
      {!live && <p role="status" className="text-center text-sm text-muted-foreground">{STATE_LABEL[call.status]}</p>}
      {(message || share.error) && (
        <div role="alert" className="space-y-1 text-center text-sm text-rose-300">
          {message && <p>{message}</p>}
          {share.error && <p>{share.error}</p>}
        </div>
      )}
      <p className="text-center text-xs leading-5 text-muted-foreground">
        Click the screen to take control · Press <kbd className="rounded border bg-muted px-1 py-0.5 font-sans">Esc</kbd> to release · Paste to type on the computer
      </p>
    </div>
  );
}
