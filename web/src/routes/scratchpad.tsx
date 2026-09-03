import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { useVoiceChat, type VoiceChatState } from '@/hooks/use-voice-chat';
import { AgentTile } from '@/components/voice/agent-tile';
import { FrameStats } from '@/components/voice/frame-stats';
import { MuteButton } from '@/components/voice/mute-button';
import { ScreenView } from '@/components/voice/screen-view';

export const Route = createFileRoute('/scratchpad')({
  component: ScratchpadPage,
});

/** What to say about the connection. Nothing while it is live: the controls speak for it. */
const STATE_LABEL: Record<VoiceChatState, string> = {
  connecting: 'Connecting…',
  ready: '',
  ended: 'Voice chat ended. Reload the page to start again.',
  error: 'Voice chat could not start.',
  'mic-denied': 'Microphone access is needed for voice chat.',
};

function ScratchpadPage() {
  const agent = useAgent();
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
  } = useVoiceChat();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Scratchpad</h2>

      <div className="flex flex-col items-center gap-4 rounded-xl bg-zinc-900 p-4">
        {/* The agent's screen, live, with the agent's own tile laid over one corner. */}
        <ScreenView
          screenRef={screenRef}
          hasScreen={hasScreen}
          controllable={hasDesktop && state === 'ready'}
          onInput={sendInput}
        >
          <div className="absolute bottom-3 left-3 w-40 drop-shadow-lg sm:w-52 md:w-64">
            <AgentTile name={agent.name} speaking={agentSpeaking} compact />
          </div>
          {hasScreen && (
            <div className="absolute bottom-3 right-3">
              <FrameStats lastFrame={lastFrame} />
            </div>
          )}
        </ScreenView>

        <div className="flex flex-col items-center gap-3">
          {STATE_LABEL[state] && <p className="text-sm text-zinc-400">{STATE_LABEL[state]}</p>}
          {message && <p className="text-xs text-zinc-500">{message}</p>}
          <MuteButton muted={muted} disabled={state !== 'ready'} onToggle={toggleMute} />
        </div>
      </div>
    </div>
  );
}
