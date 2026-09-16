import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  MessageSquare,
  Mic,
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
import { ComputerHelpPanel } from './computer-help-panel';
import { cn } from '@/lib/utils';

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
  const controlHelpId = useRef<string | undefined>(undefined);
  const ownControl = Boolean(screen.clientId) && state?.controller === screen.clientId;
  const anotherController = Boolean(state?.controller) && !ownControl;
  const waiting = data?.help?.filter((help) => help.status === 'waiting') ?? [];
  const [selectedHelpId, setSelectedHelpId] = useState(helpId);
  useEffect(() => setSelectedHelpId(helpId), [helpId]);
  const selected = waiting.find((help) => help.id === selectedHelpId) ?? waiting[0];
  const threadId =
    state?.owner?.threadId ??
    selected?.threadId ??
    data?.help?.find((help) => help.id === helpId)?.threadId;
  const [lastThreadId, setLastThreadId] = useState<string>();
  useEffect(() => {
    if (threadId) setLastThreadId(threadId);
  }, [threadId]);
  const conversationThreadId = threadId ?? lastThreadId;
  const action = async (path: string, selectedHelp?: string) => {
    setBusy(true);
    setError(null);
    try {
      await computerRequest(path, {
        clientId: screen.clientId,
        ...(selectedHelp ? { helpId: selectedHelp } : {}),
      });
      if (path === '/control') controlHelpId.current = selectedHelp;
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const handBack = async () => {
    const currentHelp = waiting.find((item) => item.id === controlHelpId.current);
    if (!currentHelp) {
      await action('/continue');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${currentHelp.id}`, {
        action: 'continue',
        clientId: screen.clientId,
      });
      controlHelpId.current = undefined;
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
            : selected
              ? 'Waiting for you'
              : 'Ready';

  return (
    <div className={cn('grid items-start gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
      <section
        aria-label="Live computer"
        className="order-2 w-full min-w-0 max-w-[calc((100dvh-12rem)*16/9)] justify-self-center overflow-hidden rounded-xl border bg-card shadow-sm xl:order-1"
      >
        <ScreenView
          className="rounded-none"
          screenRef={screen.screenRef}
          hasScreen={screen.hasScreen}
          controllable={ownControl && !busy}
          canTakeControl={!anotherController && !busy && Boolean(screen.clientId)}
          onTakeControl={() => action('/control', selected?.id)}
          onInput={screen.sendInput}
          onRelease={() => void handBack()}
          connecting={!screen.message}
        >
          {share.stream && (
            <div className="absolute left-3 top-3">
              <SharePreview stream={share.stream} />
            </div>
          )}
        </ScreenView>
        <div className="space-y-2 border-t px-3 py-2">
          <div
            aria-label="Computer controls"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-sm font-medium" role="status">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    state?.paused || (selected && !state?.owner)
                      ? 'bg-amber-500'
                      : screen.hasScreen
                        ? 'bg-emerald-500'
                        : 'bg-muted-foreground animate-pulse',
                  )}
                />
                {label}
                {Boolean(state?.waiting.length) && (
                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                    {state?.waiting.length} waiting
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {conversationThreadId && (
                  <a
                    href={`/chat/${conversationThreadId}`}
                    aria-label="Open conversation"
                    title="Open conversation"
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <MessageSquare className="size-3.5" /> Chat
                  </a>
                )}
                {state?.owner && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Stop current task"
                    disabled={busy}
                    onClick={() => void action('/stop')}
                  >
                    <Square className="size-3" /> Stop
                  </Button>
                )}
                {state?.paused && !anotherController && !selected && (
                  <Button
                    size="sm"
                    disabled={busy || !screen.clientId}
                    onClick={() => void handBack()}
                  >
                    <Play className="size-3.5" /> Return control
                  </Button>
                )}
              </div>
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                aria-label={audio.enabled ? 'Mute computer sound' : 'Play computer sound'}
                aria-pressed={audio.enabled}
                onClick={() => void audio.toggle()}
              >
                {audio.enabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                Sound {audio.enabled ? 'on' : 'off'}
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {call.isSpeaking && (
                  <AudioLines aria-label="Speaking" className="size-4 animate-pulse text-sky-500" />
                )}
                <span
                  title={call.status === 'idle' ? 'Start Talk to share your screen' : undefined}
                >
                  <ShareButton
                    sharing={share.sharing}
                    disabled={call.status !== 'live'}
                    onToggle={() => (share.sharing ? share.stop() : void share.start())}
                  />
                </span>
                {call.status === 'idle' ? (
                  <Button variant="outline" onClick={call.start}>
                    <Mic className="size-4" /> Talk
                  </Button>
                ) : (
                  <>
                    <MuteButton
                      muted={call.isMuted}
                      disabled={call.status !== 'live'}
                      onToggle={call.toggleMute}
                    />
                    <Button variant="outline" onClick={call.stop}>
                      <Pause className="size-4" /> End voice
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {anotherController ? (
              'You’re watching. Another viewer is using the computer.'
            ) : ownControl ? (
              'You have the mouse and keyboard. Press Esc to hand control back.'
            ) : (
              <>
                Click the screen to take control.{' '}
                <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px]">Esc</kbd> hands it
                back to Prism.
              </>
            )}
          </p>
          {(error || screen.message || call.error || share.error || audio.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || screen.message || call.error || share.error || audio.error}
            </p>
          )}
        </div>
      </section>
      {selected && (
        <ComputerHelpPanel
          requests={waiting}
          selected={selected}
          clientId={screen.clientId}
          disabled={busy || anotherController || !screen.clientId}
          canSelect={!ownControl && !busy}
          onSelect={setSelectedHelpId}
        />
      )}
    </div>
  );
}
