import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceWebSocketUrl } from '@/api/runtime-client';

/**
 * A live voice chat with the agent over `/api/voice`.
 *
 * The microphone is captured at 48 kHz mono and sent as pcm16 binary frames. The
 * agent's speech and the sound of the agent's browser arrive as tagged 48 kHz pcm16
 * binary frames. Both directions run through one AudioWorklet
 * (`/voice-chat-processor.js`), which plays the two incoming streams mixed and
 * reports when the agent's voice is producing sound. JSON text frames carry the
 * runtime's status and pictures of the agent's screen. Mute stops sending frames; the
 * socket and the session stay up.
 */

export type VoiceChatState = 'connecting' | 'ready' | 'ended' | 'error' | 'mic-denied';

interface StatusFrame {
  type: 'status';
  state: 'connecting' | 'ready' | 'ended' | 'error';
  message?: string;
  /** With `ready`: whether the runtime takes pointer and keyboard input for its screen. */
  desktop?: boolean;
}

/** The last picture of the screen that arrived: how many so far, when, and how big. */
export interface FrameEvent {
  count: number;
  /** `performance.now()` at arrival. */
  at: number;
  /** Encoded size of that picture, in bytes. */
  bytes: number;
}

/** The user's pointer and keyboard on the agent's screen, sent as JSON text frames. */
export type InputFrame =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'pointer_move'; dx: number; dy: number }
  | { type: 'pointer_button'; button: 'left' | 'middle' | 'right'; down: boolean }
  | { type: 'wheel'; dy: number }
  | { type: 'key'; key: string; code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
  | { type: 'text'; text: string };

/** The user's own shared screen, a picture a second while it lasts. */
export type ScreenShareFrame =
  | { type: 'user_screen_started' }
  | { type: 'user_screen'; data: string; width: number; height: number }
  | { type: 'user_screen_stopped' };

/** Everything the page sends the runtime as JSON text. */
export type PageFrame = InputFrame | ScreenShareFrame;

/** One picture of the agent's screen, as base64 JPEG. */
interface ScreenFrame {
  type: 'screen';
  data: string;
}

type ServerFrame = StatusFrame | ScreenFrame;

type WorkletMessage =
  | { type: 'capture'; pcm: ArrayBuffer }
  | { type: 'playing'; value: boolean };

/** Matches the runtime's `MEETING_SAMPLE_RATE`, so no resampling happens here. */
const SAMPLE_RATE = 48000;
/**
 * A binary frame from the runtime starts with a tag byte and a padding byte, then
 * pcm16. The tag says whose sound it is. A tag this build does not know is dropped:
 * bytes that are not pcm16 played as pcm16 are a loud screech, and the runtime and
 * the bundle do not always update together.
 */
const VOICE_FRAME = 0x01;
const BROWSER_AUDIO_FRAME = 0x02;
const AUDIO_HEADER_BYTES = 2;
const WORKLET_URL = '/voice-chat-processor.js';
const WORKLET_NAME = 'voice-chat-processor';

export function useVoiceChat() {
  const [state, setState] = useState<VoiceChatState>('connecting');
  const [message, setMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  /** True once the first picture of the agent's screen has arrived. */
  const [hasScreen, setHasScreen] = useState(false);
  /** True when the runtime owns the screen it shows and takes input for it. */
  const [hasDesktop, setHasDesktop] = useState(false);
  /** The newest screen picture's arrival, for the frame readout. */
  const [lastFrame, setLastFrame] = useState<FrameEvent | null>(null);
  const mutedRef = useRef(false);
  const contextRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  /**
   * The image the screen pictures are drawn into. Written directly rather than
   * through state: several frames a second, each a long string, is no job for a
   * re-render.
   */
  const screenRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let worklet: AudioWorkletNode | null = null;

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        setState('mic-denied');
        setMessage(err instanceof Error ? err.message : 'Microphone access was denied.');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      void context.resume().catch(() => undefined);
      try {
        await context.audioWorklet.addModule(WORKLET_URL);
      } catch (err) {
        setState('error');
        setMessage(err instanceof Error ? err.message : 'Could not start audio processing.');
        return;
      }
      if (cancelled) return;

      worklet = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        const msg = event.data;
        if (msg.type === 'playing') {
          setAgentSpeaking(msg.value);
          return;
        }
        if (mutedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(msg.pcm);
      };
      source = context.createMediaStreamSource(stream);
      source.connect(worklet);
      worklet.connect(context.destination);

      ws = new WebSocket(voiceWebSocketUrl());
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data) as ServerFrame;
          if (frame.type === 'screen') {
            if (screenRef.current) screenRef.current.src = `data:image/jpeg;base64,${frame.data}`;
            setHasScreen(true);
            // Three base64 characters carry a quarter less: the JPEG is 3/4 of the text.
            const bytes = Math.floor((frame.data.length * 3) / 4);
            setLastFrame((f) => ({ count: (f?.count ?? 0) + 1, at: performance.now(), bytes }));
            return;
          }
          if (frame.type !== 'status') return;
          setState(frame.state);
          setMessage(frame.message ?? null);
          if (frame.state === 'ready') setHasDesktop(frame.desktop === true);
          return;
        }
        if (!worklet) return;
        const data = event.data as ArrayBuffer;
        if (data.byteLength <= AUDIO_HEADER_BYTES) return;
        const tag = new Uint8Array(data, 0, 1)[0];
        if (tag !== VOICE_FRAME && tag !== BROWSER_AUDIO_FRAME) return;
        const pcm = new Int16Array(data, AUDIO_HEADER_BYTES, (data.byteLength - AUDIO_HEADER_BYTES) >> 1);
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
        worklet.port.postMessage(
          { type: tag === BROWSER_AUDIO_FRAME ? 'play-screen' : 'play', samples },
          [samples.buffer],
        );
      };
      ws.onerror = () => {
        setState('error');
        setMessage('Could not reach the voice chat endpoint.');
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        setAgentSpeaking(false);
        setHasDesktop(false);
        setState((s) => (s === 'error' || s === 'mic-denied' ? s : 'ended'));
      };
    };

    void start();

    return () => {
      cancelled = true;
      ws?.close();
      worklet?.port.close();
      worklet?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => undefined);
      contextRef.current = null;
    };
  }, []);

  const toggleMute = useCallback(() => {
    // A click is also the user gesture an autoplay-blocked AudioContext needs.
    void contextRef.current?.resume().catch(() => undefined);
    setMuted((m) => {
      mutedRef.current = !m;
      return !m;
    });
  }, []);

  /** Send a page frame to the runtime: pointer, keyboard or shared screen. Dropped while not connected. */
  const sendInput = useCallback((frame: PageFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  return {
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
  };
}
