import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  MessageSquare,
  Mic,
  MousePointer2,
  Pause,
  Play,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScreenView } from '@/components/voice/screen-view';
import { MuteButton } from '@/components/voice/mute-button';
import { ShareButton } from '@/components/voice/share-button';
import { SharePreview } from '@/components/voice/share-preview';
import { useComputerScreen } from '@/hooks/use-computer-screen';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { useComputerAudio } from '@/hooks/use-computer-audio';
import { useComputerVoice } from '@/hooks/use-computer-voice';
import { useScreenShare } from '@/hooks/use-screen-share';
import { computerRequest } from '@/api/computer';
import { ComputerHelpCard } from './computer-help-card';

export function ComputerView({ helpId }: { helpId?: string }) {
  const call = useComputerVoice();
  const audio = useComputerAudio();
  const screen = useComputerScreen({ enabled: true, onAudio: audio.enqueue });
  const { data } = useComputerStatus();
  const queryClient = useQueryClient();
  const state = screen.state ?? data;
  const share = useScreenShare(screen.sendInput);
  useEffect(() => {
    if (call.status === 'idle') share.stop();
  }, [call.status, share.stop]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownControl = Boolean(screen.clientId) && state?.controller === screen.clientId;
  const anotherController = Boolean(state?.controller) && !ownControl;
  const waiting = data?.help?.filter((help) => help.status === 'waiting') ?? [];
  const selected = waiting.find((help) => help.id === helpId);
  const help = selected ? [selected, ...waiting.filter((item) => item !== selected)] : waiting;
  const action = async (path: string, selectedHelp?: string) => {
    setBusy(true);
    setError(null);
    try {
      await computerRequest(path, {
        clientId: screen.clientId,
        ...(selectedHelp ? { helpId: selectedHelp } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const label = !screen.hasScreen
    ? 'Preparing your computer'
    : ownControl
      ? 'You have control'
      : anotherController
        ? 'Another viewer has control'
        : state?.paused
          ? 'Paused · Waiting for hand-back'
          : state?.owner
            ? 'Prism is working'
            : 'Ready';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm" role="status">
          <span
            className={`size-2 rounded-full ${state?.paused ? 'bg-amber-500' : screen.hasScreen ? 'bg-emerald-500' : 'bg-muted-foreground animate-pulse'}`}
          />
          {label}
          {Boolean(state?.waiting.length) && (
            <span className="text-muted-foreground">· {state?.waiting.length} waiting</span>
          )}
        </div>
        {state?.owner?.threadId && (
          <a
            href={`/chat/${state.owner.threadId}`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <MessageSquare className="size-4" />
            Open conversation
          </a>
        )}
      </div>
      <ScreenView
        screenRef={screen.screenRef}
        hasScreen={screen.hasScreen}
        controllable={ownControl && !busy}
        onInput={screen.sendInput}
        connecting={!screen.message}
      >
        {share.stream && (
          <div className="absolute left-3 top-3">
            <SharePreview stream={share.stream} />
          </div>
        )}
      </ScreenView>
      <div className="flex flex-wrap items-center gap-2">
        {state?.paused && !anotherController ? (
          <Button disabled={busy || !screen.clientId} onClick={() => void action('/continue')}>
            <Play className="size-4" />
            Continue
          </Button>
        ) : (
          <Button
            disabled={busy || !screen.hasScreen || anotherController}
            onClick={() => void action('/control', selected?.id)}
          >
            <MousePointer2 className="size-4" />
            Take control
          </Button>
        )}
        {state?.paused && !ownControl && !anotherController && (
          <Button
            variant="outline"
            disabled={busy || !screen.clientId}
            onClick={() => void action('/control', selected?.id)}
          >
            Take control
          </Button>
        )}
        {state?.owner && (
          <Button variant="outline" disabled={busy} onClick={() => void action('/stop')}>
            <Square className="size-3.5" />
            Stop current task
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            aria-label={audio.enabled ? 'Mute computer sound' : 'Play computer sound'}
            onClick={() => void audio.toggle()}
          >
            {audio.enabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}Sound
          </Button>
          {call.isSpeaking && (
            <AudioLines aria-label="Speaking" className="size-4 animate-pulse text-sky-500" />
          )}
          {call.status === 'idle' ? (
            <Button variant="outline" onClick={call.start}>
              <Mic className="size-4" />
              Talk
            </Button>
          ) : (
            <>
              <MuteButton
                muted={call.isMuted}
                disabled={call.status !== 'live'}
                onToggle={call.toggleMute}
              />
              <Button variant="outline" onClick={call.stop}>
                <Pause className="size-4" />
                End voice
              </Button>
            </>
          )}
          <ShareButton
            sharing={share.sharing}
            disabled={call.status !== 'live'}
            onToggle={() => (share.sharing ? share.stop() : void share.start())}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {ownControl
          ? 'Click the screen to use the mouse and keyboard. Esc releases your pointer; Continue hands control back to Prism.'
          : 'Watch Prism work, or take control when you want to use the computer.'}
      </p>
      {(error || screen.message || call.error || share.error || audio.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || screen.message || call.error || share.error || audio.error}
        </p>
      )}
      {help.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {help.map((item) => (
            <ComputerHelpCard
              key={item.id}
              help={item}
              clientId={screen.clientId}
              onTakeControl={() => void action('/control', item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
