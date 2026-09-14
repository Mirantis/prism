import { useCallback, useEffect, useState } from 'react';
import { Monitor, LoaderCircle } from 'lucide-react';
import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { useVoiceChat, type Viewport, type VoiceChatState } from '@/hooks/use-voice-chat';
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

/** Connection status shown beside the computer title. */
const STATE_LABEL: Record<VoiceChatState, string> = {
  connecting: 'Connecting…',
  ready: 'Live',
  ended: 'Voice chat ended. Reload the page to start again.',
  error: 'Voice chat could not start.',
  'mic-denied': 'Microphone access is needed for voice chat.',
};

function ComputerPage() {
  const agent = useAgent();
  // The agent's screen is made the size of the box below, so the call waits for the
  // first measurement of it.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const onViewport = useCallback((size: Viewport) => {
    setViewport((current) =>
      current && current.width === size.width && current.height === size.height ? current : size,
    );
  }, []);
  const {
    state,
    message,
    muted,
    agentSpeaking,
    hasScreen,
    hasDesktop,
    lastFrame,
    screenRef,
    toggleMute,
    sendInput,
  } = useVoiceChat(viewport);
  const share = useScreenShare(sendInput);

  // A share outlives the call that had a use for it: the browser goes on capturing the
  // user's screen, and the agent it was being shown to is gone. The button is disabled by
  // then, so nothing else would stop it.
  const live = state === 'ready';
  const { sharing, stop: stopSharing } = share;
  useEffect(() => {
    if (!live && sharing) stopSharing();
  }, [live, sharing, stopSharing]);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Monitor className="size-4 text-zinc-400" /> Agent computer
          </div>
          <div role="status" className="flex items-center gap-2 text-xs text-zinc-300">
            {state === 'connecting' ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> :
              <span className={`size-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-500'}`} />}
            {STATE_LABEL[state]}
          </div>
        </div>
        <ScreenView
          screenRef={screenRef}
          hasScreen={hasScreen}
          controllable={hasDesktop && state === 'ready'}
          onInput={sendInput}
          onViewport={onViewport}
          state={state}
        >
          {hasScreen && SCREEN_STATS_SHOWN && (
            <div className="absolute bottom-3 right-3">
              <FrameStats lastFrame={lastFrame} />
            </div>
          )}
          {share.stream && (
            <div className="absolute left-3 top-3">
              <SharePreview stream={share.stream} />
            </div>
          )}
        </ScreenView>

        <div className="flex flex-col gap-4 border-t border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <AgentTile name={agent.name} speaking={agentSpeaking} connected={live} />
          <div className="flex flex-wrap items-center gap-2">
            <MuteButton muted={muted} disabled={state !== 'ready'} onToggle={toggleMute} />
            <ShareButton
              sharing={share.sharing}
              disabled={state !== 'ready'}
              onToggle={() => (share.sharing ? share.stop() : void share.start())}
            />
          </div>
        </div>
        {(message || share.error) && (
          <div role="alert" className="space-y-1 border-t border-white/10 px-4 py-3 text-sm text-rose-300">
            {message && <p>{message}</p>}
            {share.error && <p>{share.error}</p>}
          </div>
        )}
      </div>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        Click the screen to take control · Press <kbd className="rounded border bg-muted px-1 py-0.5 font-sans">Esc</kbd> to release · Paste to type on the computer
      </p>
    </div>
  );
}
