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
import { RecordButton } from '@/components/voice/record-button';
import { ShareButton } from '@/components/voice/share-button';
import { SharePreview } from '@/components/voice/share-preview';
import { useComputerScreen } from '@/hooks/use-computer-screen';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { useComputerAudio } from '@/hooks/use-computer-audio';
import { useComputerVoice } from '@/hooks/use-computer-voice';
import { useScreenRecording } from '@/hooks/use-screen-recording';
import { useScreenShare } from '@/hooks/use-screen-share';
import { computerAction, computerRequest } from '@/api/computer';
import type { ComputerSummary } from '@/types';
import { ComputerHelpPanel } from './computer-help-panel';
import { cn } from '@/lib/utils';

/**
 * One computer's live screen and its controls. Sound, voice and screen sharing belong to
 * the runtime's own desktop, so a remote computer's view leaves them out.
 */
export function ComputerView({ computer, helpId }: { computer: ComputerSummary; helpId?: string }) {
  const remote = computer.kind === 'remote';
  const call = useComputerVoice();
  // The call as it stands now, for a handler that reads it after an await: a closure's
  // copy is the one from the render the click happened in. See `toggleRecording`.
  const callRef = useRef(call);
  callRef.current = call;
  const audio = useComputerAudio();
  // Set when the runtime answers that it has begun recording, on the socket the request
  // went out on. The microphone opens then and not before, so no part of the narration
  // reaches the model live on the other socket first.
  const [micOpen, setMicOpen] = useState(false);
  const screen = useComputerScreen({
    enabled: true,
    computerId: computer.id,
    onAudio: audio.enqueue,
    onRecordingStarted: () => setMicOpen(true),
  });
  const { data } = useComputerStatus(computer.id);
  const queryClient = useQueryClient();
  const state = screen.state ?? data;
  const connected = !remote || (screen.state?.connection ?? computer.connection) === 'connected';
  // A connected computer can still lack the permission to send its screen.
  const sharing = connected && screen.state?.screen !== false;
  const share = useScreenShare(screen.sendInput);
  // The share is opened to be recorded, so it closes however the recording ends. Nothing
  // keeps capturing the user's screen once they press stop.
  const recorder = useScreenRecording(screen.sendInput, share.stop);
  const { recording } = recorder;
  useEffect(() => {
    if (call.status === 'idle') share.stop();
  }, [call.status, share.stop]);

  // A recording holds the microphone open for as long as it runs, whatever the call was
  // set to, and gives it back at the end however the recording ended. The agent hears none
  // of it live: the runtime puts those frames in the recording instead.
  const mutedBeforeRecording = useRef(true);
  const { setMuted } = call;
  useEffect(() => {
    if (!micOpen) return;
    setMuted(false);
    return () => setMuted(mutedBeforeRecording.current);
  }, [micOpen, setMuted]);

  // The runtime answers each recording, so the microphone closes with the one it opened
  // for. A recording that ends before the answer arrives leaves it shut.
  useEffect(() => {
    if (!recording) setMicOpen(false);
  }, [recording]);

  // A recording that outlives the socket its pictures travel on has nowhere to go, so it
  // ends here rather than running to its limit holding the microphone. The socket comes
  // back on its own, but as a new client, and the session dropped the old one's recording.
  const { abandon } = recorder;
  const clientId = screen.clientId;
  useEffect(() => {
    if (!recording || clientId) return;
    abandon('The connection to the screen dropped, so that recording was not sent.');
  }, [recording, clientId, abandon]);

  // Sound covers everything this page plays, the agent's voice included: one control, and
  // pressing it is silence at once. The runtime goes on sending and the model goes on
  // generating — this is the speaker rather than the call.
  const { setPlaybackMuted } = call;
  useEffect(() => {
    setPlaybackMuted(!audio.enabled);
  }, [audio.enabled, setPlaybackMuted]);

  // A recording ends with the call, since the model it would be handed to goes with it.
  const { stop: stopRecording } = recorder;
  useEffect(() => {
    if (call.status === 'idle' && recording) stopRecording();
  }, [call.status, recording, stopRecording]);

  const toggleRecording = async () => {
    if (recording) {
      recorder.stop();
      return;
    }
    // Recording the screen means sharing it, so a first press opens the picker and records
    // what it hands back.
    const stream = share.stream ?? (await share.start());
    if (!stream) return;
    // Read from the ref rather than this closure's `call`: the picker is open across the
    // await, the microphone control stays live while it is, and somebody who mutes there
    // would otherwise have it reopened for them when the recording ends.
    mutedBeforeRecording.current = callRef.current?.isMuted ?? true;
    recorder.start(stream);
  };
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
  const action = async (name: 'control' | 'continue' | 'stop', selectedHelp?: string) => {
    setBusy(true);
    setError(null);
    try {
      await computerAction(computer.id, name, {
        clientId: screen.clientId,
        ...(selectedHelp ? { helpId: selectedHelp } : {}),
      });
      if (name === 'control') controlHelpId.current = selectedHelp;
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
      await action('continue');
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
  const label = !connected
    ? 'Not connected'
    : !screen.hasScreen
      ? sharing ? 'Preparing your computer' : 'Screen not shared'
      : ownControl
        ? state?.secure
          ? 'You have control · Prism is stopped'
          : 'You have control'
        : state?.controller === 'local'
          ? `The person at ${computer.name} has control`
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
          onTakeControl={() => action('control', selected?.id)}
          onInput={screen.sendInput}
          onRelease={() => void handBack()}
          connecting={sharing && !screen.message}
          unavailable={
            !remote
              ? undefined
              : !connected
                ? {
                    title: 'Not connected',
                    detail: `Start the computer client on ${computer.name}. Its screen appears here when it connects.`,
                  }
                : !sharing
                  ? {
                      title: 'Screen not shared',
                      detail:
                        computer.problems.find((problem) => problem.capability === 'stream')?.message ??
                        `Allow the computer client on ${computer.name} to record the screen.`,
                    }
                  : undefined
          }
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
                    !sharing
                      ? 'bg-muted-foreground'
                      : state?.paused || (selected && !state?.owner)
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
                    onClick={() => void action('stop')}
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

            {!remote && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  aria-label={audio.enabled ? 'Mute sound' : 'Play sound'}
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
                  {/* Both show the agent something during a call, so neither is offered
                      while there is no call to show it to. */}
                  {call.status !== 'idle' && (
                    <>
                      <ShareButton
                        sharing={share.sharing}
                        disabled={call.status !== 'live' || recording}
                        onToggle={() => (share.sharing ? share.stop() : void share.start())}
                      />
                      <RecordButton
                        recording={recording}
                        elapsedMs={recorder.elapsedMs}
                        // Readiness gates starting a recording, never ending one: a socket
                        // that goes while one runs would otherwise leave the control dead and
                        // the microphone held until the length limit.
                        disabled={!recording && (call.status !== 'live' || !screen.clientId)}
                        onToggle={() => void toggleRecording()}
                      />
                    </>
                  )}
                  {call.status === 'idle' ? (
                    <Button variant="outline" className="h-10" onClick={call.start}>
                      <Mic className="size-4" /> Talk
                    </Button>
                  ) : (
                    <>
                      <MuteButton
                        muted={call.isMuted}
                        disabled={call.status !== 'live' || recording}
                        onToggle={call.toggleMute}
                      />
                      <Button variant="outline" className="h-10" onClick={call.stop}>
                        <Pause className="size-4" /> End voice
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* The screen itself says what to do while the computer is not connected or not sharing it. */}
          {sharing && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {state?.controller === 'local' ? (
                `You’re watching. Somebody at ${computer.name} is using it.`
              ) : anotherController ? (
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
          )}
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
