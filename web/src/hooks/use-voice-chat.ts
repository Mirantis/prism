import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceWebSocketUrl } from '@/api/runtime-client';
import { startVoiceAudio, type VoiceAudio } from '@/lib/voice-audio';

/**
 * A live voice chat with the agent over `/api/voice`, the session that comes with a
 * computer the agent works on.
 *
 * The microphone and the playback are `lib/voice-audio.ts`, the same pair the call from
 * the chat composer uses. This hook is the socket: binary frames are audio, tagged with
 * whose sound they are, and JSON text frames carry the runtime's status and pictures of
 * the agent's screen. Mute stops sending frames; the socket and the session stay up.
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

/** The size of the rectangle the page shows the agent's screen in, in device pixels. */
export type ViewportFrame = { type: 'viewport'; width: number; height: number };

/** Everything the page sends the runtime as JSON text. */
export type PageFrame = InputFrame | ScreenShareFrame | ViewportFrame;

/** The size of the rectangle the page shows the agent's screen in. */
export interface Viewport {
  width: number;
  height: number;
}

/** One picture of the agent's screen, as base64 JPEG. */
interface ScreenFrame {
  type: 'screen';
  data: string;
}

/** Drop the agent's speech that has not been played yet, because it was interrupted. */
interface ClearFrame {
  type: 'clear';
}

type ServerFrame = StatusFrame | ScreenFrame | ClearFrame;

/**
 * The rate this session speaks, both ways. It is the rate the agent's screen is recorded
 * at, so the sound of a video playing on it arrives unresampled.
 */
const SAMPLE_RATE = 48_000;
/**
 * A binary frame from the runtime starts with a tag byte and a padding byte, then
 * pcm16. The tag says whose sound it is. A tag this build does not know is dropped:
 * bytes that are not pcm16 played as pcm16 are a loud screech, and the runtime and
 * the bundle do not always update together.
 */
const VOICE_FRAME = 0x01;
const COMPUTER_AUDIO_FRAME = 0x02;
const AUDIO_HEADER_BYTES = 2;

/**
 * `viewport` is the rectangle the page will show the screen in. The call waits for the
 * first one, since the runtime makes the agent's screen that size and a desktop that has
 * to be resized after it has laid itself out is a desktop the user watches rearrange.
 */
export function useVoiceChat(viewport: Viewport | null) {
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
  const audioRef = useRef<VoiceAudio | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  /**
   * The image the screen pictures are drawn into. Written directly rather than
   * through state: several frames a second, each a long string, is no job for a
   * re-render.
   */
  const screenRef = useRef<HTMLImageElement | null>(null);
  /** The size the call opened with, so a later change is a change rather than a reconnect. */
  const openedWith = useRef<Viewport | null>(null);
  if (viewport && !openedWith.current) openedWith.current = viewport;
  const ready = openedWith.current !== null;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let audio: VoiceAudio | null = null;

    /**
     * Let go of the microphone and the socket.
     *
     * Both are dropped before either is closed, so the close that follows cannot come
     * back through here: the runtime ends a session and closes the socket in one go, and
     * the two paths that answer that both land on this.
     */
    const release = (): void => {
      const openAudio = audio;
      const socket = ws;
      audio = null;
      ws = null;
      audioRef.current = null;
      setAgentSpeaking(false);
      setHasDesktop(false);
      void openAudio?.stop().catch(() => undefined);
      socket?.close();
    };

    const start = async (): Promise<void> => {
      try {
        audio = await startVoiceAudio({
          sampleRate: SAMPLE_RATE,
          onFrame: (frame) => {
            if (mutedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(frame);
          },
          onSpeaking: setAgentSpeaking,
        });
      } catch (err) {
        // The microphone is the one refusal worth naming on its own: it is the user's to
        // give back, and the page can tell them how. Anything else is the audio path
        // failing to open, which the user cannot act on, so the message says what
        // happened and the console carries the rest.
        const denied = err instanceof Error && err.name === 'NotAllowedError';
        if (!denied) console.error('[voice] the audio path did not open', err);
        setState(denied ? 'mic-denied' : 'error');
        setMessage(
          denied
            ? 'The microphone is blocked. Allow it in the browser, then reload the page.'
            : 'Could not start the audio for this call.',
        );
        return;
      }
      if (cancelled) {
        void audio.stop().catch(() => undefined);
        audio = null;
        return;
      }
      audioRef.current = audio;

      ws = new WebSocket(voiceWebSocketUrl(openedWith.current ?? undefined));
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
          if (frame.type === 'clear') {
            audioRef.current?.clear();
            setAgentSpeaking(false);
            return;
          }
          if (frame.type !== 'status') return;
          setState(frame.state);
          setMessage(frame.message ?? null);
          if (frame.state === 'ready') setHasDesktop(frame.desktop === true);
          // The call is over: another page took it, the model's session died, or the
          // runtime refused it. Nothing more is coming, and the browser goes on showing
          // this tab as recording until the microphone is let go.
          if (frame.state === 'ended' || frame.state === 'error') release();
          return;
        }
        const data = event.data as ArrayBuffer;
        if (data.byteLength <= AUDIO_HEADER_BYTES) return;
        const tag = new Uint8Array(data, 0, 1)[0];
        if (tag !== VOICE_FRAME && tag !== COMPUTER_AUDIO_FRAME) return;
        // Cut to whole samples: pcm16 is two bytes each, and a trailing half sample would
        // throw on the audio thread rather than play as one bad sample.
        const samples = (data.byteLength - AUDIO_HEADER_BYTES) >> 1;
        const pcm = data.slice(AUDIO_HEADER_BYTES, AUDIO_HEADER_BYTES + samples * 2);
        if (tag === COMPUTER_AUDIO_FRAME) audioRef.current?.enqueueComputer(pcm);
        else audioRef.current?.enqueue(pcm);
      };
      ws.onerror = () => {
        setState('error');
        setMessage('Could not reach the voice chat endpoint.');
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        release();
        setState((s) => (s === 'error' || s === 'mic-denied' ? s : 'ended'));
      };
    };

    void start();

    return () => {
      cancelled = true;
      release();
    };
  }, [ready]);

  // Later sizes go as frames. The box settles them before reporting, so each one here is
  // a size the user stopped at rather than a step of a drag.
  useEffect(() => {
    const ws = wsRef.current;
    if (!viewport || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (viewport.width === openedWith.current?.width && viewport.height === openedWith.current?.height) {
      return;
    }
    ws.send(JSON.stringify({ type: 'viewport', ...viewport }));
  }, [viewport]);

  const toggleMute = useCallback(() => {
    // Also the gesture an autoplay-blocked context was waiting for.
    audioRef.current?.resume();
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
