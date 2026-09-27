import { useCallback, useEffect, useRef, useState } from 'react';
import { audioLevel } from '@/lib/audio-level';
import { startVoiceAudio, VOICE_SAMPLE_RATE, type VoiceAudio } from '@/lib/voice-audio';
import type { DictationEvent } from '@/lib/chat-socket/protocol';

/**
 * A spoken message: the microphone, the wait for the words, and the state a composer
 * shows.
 *
 * The audio goes up the chat socket in the format a voice call uses, and the runtime
 * answers with text. The text goes to `onTranscript` to be sent as the user's message;
 * nothing is played and nothing is kept.
 *
 * An abandoned dictation is always stopped on the runtime. The frames carry no id, so a
 * runtime still transcribing an old recording would refuse the next start, and its late
 * result would read as the new one's words. One socket keeps that stop ahead of the next
 * start.
 */

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface UseDictationOptions {
  /** Asks the runtime to transcribe. False when the socket is not open. */
  sendDictationStart: () => boolean;
  sendDictationStop: (commit: boolean) => void;
  sendAudio: (frame: ArrayBuffer) => void;
  isConnected: boolean;
  /** The words, trimmed and never empty. */
  onTranscript: (text: string) => void;
  /** How long a committed recording has to come back as words. */
  resultTimeoutMs?: number;
}

export interface Dictation {
  status: DictationStatus;
  /**
   * The microphone's level over the last few seconds, 0 to 1, oldest first. One entry per
   * meter tick, silence included, so a pause draws as a flat stretch.
   */
  levels: number[];
  /** When the recording started, for the timer. */
  startedAt: number | null;
  /** Why the last dictation failed, in words. Cleared by the next one. */
  error: string | null;
  start: () => void;
  /** Stop recording and send what was said. */
  send: () => void;
  /** Drop the recording. Nothing is sent. */
  cancel: () => void;
  /** Feed a dictation frame in. Wired to `onDictationEvent` on the chat socket. */
  handleEvent: (event: DictationEvent) => void;
}

/** How often the waveform reads the microphone's level. */
const METER_MS = 60;

/** How many readings the waveform keeps. */
export const DICTATION_LEVELS = 64;

const SILENT_LEVELS: number[] = Array(DICTATION_LEVELS).fill(0);

export function useDictation(options: UseDictationOptions): Dictation {
  const {
    sendDictationStart,
    sendDictationStop,
    sendAudio,
    isConnected,
    onTranscript,
    resultTimeoutMs = 35_000,
  } = options;

  const [status, setStatus] = useState<DictationStatus>('idle');
  const [levels, setLevels] = useState<number[]>(SILENT_LEVELS);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Written first and rendered second, as in `useVoiceCall`: starting spans the
  // microphone prompt, and a mirror refreshed on render would read a stale status then.
  const statusRef = useRef<DictationStatus>('idle');
  const setDictationStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const audioRef = useRef<VoiceAudio | null>(null);
  const peakRef = useRef(0);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which press the microphone prompt belongs to. A prompt answered after its press was
  // cancelled, and another started, must not act on the newer one.
  const attemptRef = useRef(0);
  // Bound once by the audio path and by the socket handler, so both are read late.
  const sendAudioRef = useRef(sendAudio);
  sendAudioRef.current = sendAudio;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  /** Release the microphone and the timers. Safe to call when there is nothing open. */
  const release = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (meterRef.current) clearInterval(meterRef.current);
    meterRef.current = null;
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    peakRef.current = 0;
    setLevels(SILENT_LEVELS);
    setStartedAt(null);
    void audio?.stop().catch(() => {});
  }, []);

  /** End with a failure the user reads, and tell the runtime to drop the recording. */
  const fail = useCallback(
    (message: string) => {
      if (statusRef.current === 'idle') return;
      release();
      setDictationStatus('idle');
      setError(message);
      sendDictationStop(false);
    },
    [release, sendDictationStop, setDictationStatus],
  );

  const start = useCallback(() => {
    if (statusRef.current !== 'idle') return;
    setError(null);
    if (!isConnected) {
      setError('Not connected to the agent right now.');
      return;
    }
    setDictationStatus('starting');
    const attempt = ++attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt && statusRef.current === 'starting';
    // The microphone first, and only then the dictation: a denied permission must not
    // leave the runtime holding a recording nobody speaks into.
    void startVoiceAudio({
      sampleRate: VOICE_SAMPLE_RATE,
      onFrame: (frame) => {
        // Frames before the start are dropped: the runtime has no dictation to put
        // them in yet, and the gap is the first frame or two after the prompt.
        if (statusRef.current !== 'recording') return;
        peakRef.current = Math.max(peakRef.current, audioLevel(frame));
        sendAudioRef.current(frame);
      },
    })
      .then((audio) => {
        if (!isCurrent()) {
          void audio.stop().catch(() => {});
          return;
        }
        audioRef.current = audio;
        if (!sendDictationStart()) {
          release();
          setDictationStatus('idle');
          setError('Not connected to the agent right now.');
          return;
        }
        setStartedAt(Date.now());
        setDictationStatus('recording');
        meterRef.current = setInterval(() => {
          const peak = peakRef.current;
          peakRef.current = 0;
          setLevels((previous) => [...previous.slice(1), peak]);
        }, METER_MS);
      })
      .catch((err: unknown) => {
        console.error('[dictation] the microphone did not open', err);
        if (!isCurrent()) return;
        setDictationStatus('idle');
        setError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'The microphone is blocked. Allow it in the browser, then try again.'
            : 'Could not open the microphone.',
        );
      });
  }, [isConnected, release, sendDictationStart, setDictationStatus]);

  const send = useCallback(() => {
    if (statusRef.current !== 'recording') return;
    release();
    setDictationStatus('transcribing');
    sendDictationStop(true);
    watchdogRef.current = setTimeout(
      () => fail('The transcript did not arrive. Try again.'),
      resultTimeoutMs,
    );
  }, [fail, release, resultTimeoutMs, sendDictationStop, setDictationStatus]);

  const cancel = useCallback(() => {
    const current = statusRef.current;
    if (current === 'idle') return;
    release();
    setDictationStatus('idle');
    // Nothing reached the runtime while the microphone was still being opened.
    if (current !== 'starting') sendDictationStop(false);
  }, [release, sendDictationStop, setDictationStatus]);

  const handleEvent = useCallback(
    (event: DictationEvent) => {
      // A frame for a dictation this side already gave up on.
      if (statusRef.current === 'idle' || statusRef.current === 'starting') return;
      switch (event.type) {
        case 'hello':
          if (
            event.format.encoding !== 'pcm16' ||
            event.format.sampleRate !== VOICE_SAMPLE_RATE ||
            event.format.channels !== 1
          ) {
            fail('The agent asked for audio this browser does not record.');
          }
          break;
        case 'delta':
          break;
        case 'result': {
          // The runtime also answers on its own at its recording cap, while this side
          // is still recording.
          release();
          setDictationStatus('idle');
          const words = event.text.trim();
          if (words) onTranscriptRef.current(words);
          else setError('No speech was heard.');
          break;
        }
        case 'error':
          fail(event.error);
          break;
      }
    },
    [fail, release, setDictationStatus],
  );

  // The runtime drops a dictation with its socket, so hold nothing open on this side.
  useEffect(() => {
    if (isConnected || statusRef.current === 'idle') return;
    release();
    setDictationStatus('idle');
    setError('The connection dropped, so the dictation ended.');
  }, [isConnected, release, setDictationStatus]);

  // A page that navigates away releases the microphone too.
  useEffect(() => release, [release]);

  return { status, levels, startedAt, error, start, send, cancel, handleEvent };
}
