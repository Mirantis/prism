import { useCallback, useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { useVoiceChat, type Viewport, type VoiceChatState } from '@/hooks/use-voice-chat';
import { useScreenShare } from '@/hooks/use-screen-share';
import { AgentTile } from '@/components/voice/agent-tile';
import { FrameStats } from '@/components/voice/frame-stats';
import { MuteButton } from '@/components/voice/mute-button';
import { ScreenView } from '@/components/voice/screen-view';
import { ShareButton } from '@/components/voice/share-button';
import { SharePreview } from '@/components/voice/share-preview';

export const Route = createFileRoute('/computer')({
  component: ComputerPage,
});

/** What to say about the connection. Nothing while it is live: the controls speak for it. */
const STATE_LABEL: Record<VoiceChatState, string> = {
  connecting: 'Connecting…',
  ready: '',
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
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4 rounded-xl bg-zinc-900 p-4">
        {/* The agent's screen, live, with the agent's own tile laid over one corner. */}
        <ScreenView
          screenRef={screenRef}
          hasScreen={hasScreen}
          controllable={hasDesktop && state === 'ready'}
          onInput={sendInput}
          onViewport={onViewport}
        >
          <div className="absolute bottom-3 left-3 w-40 drop-shadow-lg sm:w-52 md:w-64">
            <AgentTile name={agent.name} speaking={agentSpeaking} compact />
          </div>
          {hasScreen && (
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

        <div className="flex flex-col items-center gap-3">
          {STATE_LABEL[state] && <p className="text-sm text-zinc-400">{STATE_LABEL[state]}</p>}
          {message && <p className="text-xs text-zinc-500">{message}</p>}
          {share.error && <p className="text-xs text-red-400">{share.error}</p>}
          <div className="flex items-center gap-3">
            <MuteButton muted={muted} disabled={state !== 'ready'} onToggle={toggleMute} />
            <ShareButton
              sharing={share.sharing}
              disabled={state !== 'ready'}
              onToggle={() => (share.sharing ? share.stop() : void share.start())}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
