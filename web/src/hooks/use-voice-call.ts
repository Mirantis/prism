import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoiceAudio, VOICE_SAMPLE_RATE, type VoiceAudio } from '@/lib/voice-audio';
import type { VoiceEvent, VoiceFormat } from './use-websocket';

/**
 * A voice call with the agent: the microphone, the playback, and the call's state.
 *
 * Takes the three senders from the chat socket and returns what a control renders —
 * whether a call is running, whether the microphone is muted, whether the agent is
 * speaking, and the last refusal in words. The state is held here only; a call writes
 * nothing to the thread.
 */

export type VoiceCallStatus = 'idle' | 'starting' | 'live';

export interface UseVoiceCallOptions {
  /** Asks the runtime for a session. False when the socket is not open. */
  sendVoiceStart: (threadId?: string) => boolean;
  sendVoiceStop: () => void;
  sendVoiceAudio: (frame: ArrayBuffer) => void;
  /** The thread the call is started from, so the agent's tools have one. */
  threadId?: string;
  /** A call cannot start without the socket, and a call in progress ends with it. */
  isConnected: boolean;
}

export interface VoiceCall {
  status: VoiceCallStatus;
  /** The agent's audio is playing right now. */
  isSpeaking: boolean;
  /** The microphone is muted: the call runs on, and the agent hears nothing. */
  isMuted: boolean;
  /** Why the last call could not start, or could not continue. Cleared by the next one. */
  error: string | null;
  start: () => void;
  stop: () => void;
  /** Mute the microphone, or open it again. The session and the playback are untouched. */
  toggleMute: () => void;
  /** Feed a voice frame in. Wired to `onVoiceEvent` on the chat socket. */
  handleEvent: (event: VoiceEvent) => void;
  /** Feed a frame of the agent's speech in. Wired to `onVoiceAudio`. */
  handleAudio: (frame: ArrayBuffer) => void;
}

/** The one format this client can send and play. */
function isSupported(format: VoiceFormat): boolean {
  return (
    format.encoding === 'pcm16' &&
    format.sampleRate === VOICE_SAMPLE_RATE &&
    format.channels === 1
  );
}

export function useVoiceCall(options: UseVoiceCallOptions): VoiceCall {
  const { sendVoiceStart, sendVoiceStop, sendVoiceAudio, threadId, isConnected } = options;

  const [status, setStatus] = useState<VoiceCallStatus>('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<VoiceAudio | null>(null);
  // The frames arrive on the socket handler, which is bound once, so the senders are
  // read through refs for the same reason the socket's callbacks are.
  const sendAudioRef = useRef(sendVoiceAudio);
  sendAudioRef.current = sendVoiceAudio;

  // The status is written here first and rendered second. Starting a call spans an
  // await — the microphone prompt — and a mirror refreshed on render would still read
  // `idle` when that resolves, so the call would look cancelled the moment it began.
  const statusRef = useRef<VoiceCallStatus>('idle');
  const setCallStatus = useCallback((next: VoiceCallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // Mirrored for the same reason: `onFrame` is bound when the audio path opens and
  // reads the flag on every frame after that.
  const isMutedRef = useRef(false);
  const setMuted = useCallback((next: boolean) => {
    isMutedRef.current = next;
    setIsMuted(next);
  }, []);

  /** Release the microphone and the playback. Safe to call when there is nothing open. */
  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    setIsSpeaking(false);
    // Nothing about a mute outlives the call it was made in.
    setMuted(false);
    // The stop is asynchronous but nothing waits on it: the call is over either way,
    // and a failure to close a context is not something to tell the user about.
    void audio?.stop().catch(() => {});
  }, [setMuted]);

  const toggleMute = useCallback(() => {
    setMuted(!isMutedRef.current);
  }, [setMuted]);

  const start = useCallback(() => {
    if (statusRef.current !== 'idle') return;
    setError(null);

    if (!isConnected) {
      setError('Not connected to the agent right now.');
      return;
    }

    setCallStatus('starting');
    // The microphone first, and only then the session: a denied permission must not
    // leave the runtime holding a call nobody can talk to. This is the one refusal the
    // client owns, since the runtime never hears about it.
    void startVoiceAudio({
      sampleRate: VOICE_SAMPLE_RATE,
      // Mute is a frame the client does not send. The microphone stays open, so
      // unmuting is silence ending rather than a second permission prompt.
      onFrame: (frame) => {
        if (isMutedRef.current) return;
        sendAudioRef.current(frame);
      },
      onSpeaking: setIsSpeaking,
    })
      .then((audio) => {
        if (statusRef.current !== 'starting') {
          void audio.stop().catch(() => {});
          return;
        }
        audioRef.current = audio;
        if (sendVoiceStart(threadId)) return;
        // The socket went away between the click and the permission.
        releaseAudio();
        setCallStatus('idle');
        setError('Not connected to the agent right now.');
      })
      .catch((err: unknown) => {
        // The one sentence below cannot say which of getUserMedia, the audio context and
        // the worklet module failed, and an error's name and message are not speech.
        console.error('[voice] the audio path did not open', err);
        setCallStatus('idle');
        setError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'The microphone is blocked. Allow it in the browser, then start the call again.'
            : 'Could not open the microphone.',
        );
      });
  }, [isConnected, releaseAudio, sendVoiceStart, setCallStatus, threadId]);

  const stop = useCallback(() => {
    if (statusRef.current === 'idle') return;
    // The microphone goes now rather than when the runtime answers: the user asked for
    // the call to end, and the recording indicator is what they are watching.
    releaseAudio();
    setCallStatus('idle');
    sendVoiceStop();
  }, [releaseAudio, sendVoiceStop, setCallStatus]);

  const handleEvent = useCallback(
    (event: VoiceEvent) => {
      switch (event.type) {
        case 'hello':
          // The runtime states the format it will send. Nothing here can transcode, so
          // a session in another format is ended rather than played as noise.
          if (!isSupported(event.format)) {
            releaseAudio();
            setCallStatus('idle');
            setError('The agent offered audio this browser cannot play.');
            sendVoiceStop();
          }
          break;
        case 'state':
          if (event.state === 'live') {
            if (statusRef.current !== 'idle') setCallStatus('live');
            break;
          }
          releaseAudio();
          setCallStatus('idle');
          break;
        case 'clear':
          audioRef.current?.clear();
          setIsSpeaking(false);
          break;
        case 'error':
          // A refusal arrives on its own, with no `ended` behind it, so this is the
          // whole of the answer: say why and give the control back.
          releaseAudio();
          setCallStatus('idle');
          setError(event.error);
          break;
      }
    },
    [releaseAudio, sendVoiceStop, setCallStatus],
  );

  const handleAudio = useCallback((frame: ArrayBuffer) => {
    audioRef.current?.enqueue(frame);
  }, []);

  // A socket that dropped mid-call takes the call with it: the runtime ends the session
  // when the client disconnects, so hold nothing open on this side either.
  useEffect(() => {
    if (isConnected || statusRef.current === 'idle') return;
    releaseAudio();
    setCallStatus('idle');
    setError('The connection dropped, so the call ended.');
  }, [isConnected, releaseAudio, setCallStatus]);

  // A tab that navigates away releases the microphone too.
  useEffect(() => releaseAudio, [releaseAudio]);

  return { status, isSpeaking, isMuted, error, start, stop, toggleMute, handleEvent, handleAudio };
}
