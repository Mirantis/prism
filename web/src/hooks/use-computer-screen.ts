import { useCallback, useEffect, useRef, useState } from 'react';
import { computerWebSocketUrl } from '@/api/runtime-client';
import type { ComputerStatus } from '@/types';
import { canDecodeVideo, ScreenCanvas } from '@/lib/screen-canvas';

/** Live desktop video, sound, and user input on a dedicated socket. */

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
/**
 * A recording of that shared screen: it began, a picture the page kept with the offset it
 * was taken at, and the end. The pictures are sent together, before the end.
 */
export type RecordingFrame =
  | { type: 'recording_started' }
  | { type: 'recording_frame'; data: string; at: number }
  | { type: 'recording_stopped'; ms: number; reason: 'user' | 'limit' | 'share_ended' }
  | { type: 'recording_cancelled' };

export type PageFrame = InputFrame | ScreenShareFrame | RecordingFrame;

/** How the agent's screen is encoded, before any of it arrives. */
interface ScreenStartFrame {
  type: 'screen_start';
  encoding: 'jpeg' | 'h264';
  /** With `h264`: the name the decoder is configured with. */
  codec?: string;
}

/** One picture of the agent's screen, as base64 JPEG. */
interface ScreenPictureFrame {
  type: 'screen';
  data: string;
}

/** Why the runtime is closing this socket, when it is not the page's doing. */
interface ErrorFrame {
  type: 'error';
  message: string;
}

/**
 * The call has begun recording the user's screen, and so is taking their microphone.
 *
 * It answers on this socket rather than the one the microphone travels on, and the page
 * opens the microphone only when it arrives: two sockets have no order between them, so
 * without this the first words of a narration can reach the model live.
 */
interface RecordingStartedFrame {
  type: 'recording_started';
}

type ServerFrame = ScreenStartFrame | ScreenPictureFrame | ErrorFrame | RecordingStartedFrame;

/**
 * A binary frame from the runtime starts with a tag byte and a padding byte. The tag says
 * what is in it. A tag this build does not know is dropped: bytes that are not pcm16
 * played as pcm16 are a loud screech, and the runtime and the bundle do not always update
 * together.
 */
const DESKTOP_AUDIO_FRAME = 0x02;
/**
 * A binary frame that is one picture of the agent's screen; its second byte says whether
 * that picture stands on its own.
 */
const SCREEN_VIDEO_FRAME = 0x03;
const HEADER_BYTES = 2;

export interface UseComputerScreenOptions {
  /** Connect while the Computer page is open. */
  enabled: boolean;
  /** Playback for the desktop's sound. */
  onAudio: (pcm: ArrayBuffer) => void;
  /** Called when the runtime says it has begun recording the user's screen. */
  onRecordingStarted?: () => void;
}

export interface ComputerScreen {
  clientId: string | null;
  state: ComputerStatus | null;
  /** The canvas the screen is drawn into. */
  screenRef: React.RefObject<HTMLCanvasElement | null>;
  /** True once the first picture of the agent's screen has arrived. */
  hasScreen: boolean;
  /** The newest picture's arrival, for the frame readout. */
  lastFrame: FrameEvent | null;
  /** Set when this browser cannot show the screen; the call is unaffected. */
  message: string | null;
  /** Send a page frame: pointer, keyboard or shared screen. Dropped while not connected. */
  sendInput: (frame: PageFrame) => void;
}

export function useComputerScreen(options: UseComputerScreenOptions): ComputerScreen {
  const { enabled, onAudio } = options;

  const [clientId, setClientId] = useState<string | null>(null);
  const [state, setState] = useState<ComputerStatus | null>(null);
  const [connection, setConnection] = useState(0);
  const [hasScreen, setHasScreen] = useState(false);
  const [lastFrame, setLastFrame] = useState<FrameEvent | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  /**
   * The canvas the screen pictures are drawn into. Written directly rather than through
   * state: several frames a second, each a long string, is no job for a re-render.
   */
  const screenRef = useRef<HTMLCanvasElement | null>(null);
  /** Draws the screen, whichever way it arrives. */
  const canvasRef = useRef<ScreenCanvas | null>(null);
  // Read on every frame by a handler bound once, the same reason the senders are.
  const onAudioRef = useRef(onAudio);
  onAudioRef.current = onAudio;
  const onRecordingStartedRef = useRef(options.onRecordingStarted);
  onRecordingStartedRef.current = options.onRecordingStarted;
  useEffect(() => {
    if (!enabled) return;
    const canvas = new ScreenCanvas(() => screenRef.current);
    canvasRef.current = canvas;

    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    setMessage(null);
    const ws = new WebSocket(computerWebSocketUrl());
    wsRef.current = ws;
    ws.onclose = () => {
      if (disposed) return;
      setClientId(null);
      setHasScreen(false);
      setMessage('Reconnecting to the computer…');
      reconnect = setTimeout(() => setConnection((value) => value + 1), 2000);
    };
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data) as ServerFrame | (ComputerStatus & { type: 'computer_state'; clientId: string });
        if (frame.type === 'computer_state') { setClientId(frame.clientId); setState(frame); return; }
        if (frame.type === 'screen_start') {
          if (frame.encoding === 'h264' && frame.codec) {
            if (!canDecodeVideo()) {
              setMessage('This browser cannot show the agent’s screen. Open Computer in Chrome.');
              return;
            }
            canvas.openVideo(frame.codec);
          } else {
            canvas.openPictures();
          }
          return;
        }
        if (frame.type === 'screen') {
          canvas.picture(frame.data);
          setHasScreen(true);
          // Three base64 characters carry a quarter less: the JPEG is 3/4 of the text.
          const bytes = Math.floor((frame.data.length * 3) / 4);
          setLastFrame((f) => ({ count: (f?.count ?? 0) + 1, at: performance.now(), bytes }));
          return;
        }
        if (frame.type === 'recording_started') {
          onRecordingStartedRef.current?.();
          return;
        }
        if (frame.type === 'error') setMessage(frame.message);
        return;
      }
      const data = event.data as ArrayBuffer;
      if (data.byteLength <= HEADER_BYTES) return;
      const tag = new Uint8Array(data, 0, 1)[0];
      if (tag === SCREEN_VIDEO_FRAME) {
        const keyframe = new Uint8Array(data, 1, 1)[0] === 1;
        canvas.video(data.slice(HEADER_BYTES), keyframe);
        setHasScreen(true);
        setLastFrame((f) => ({
          count: (f?.count ?? 0) + 1,
          at: performance.now(),
          bytes: data.byteLength - HEADER_BYTES,
        }));
        return;
      }
      if (tag !== DESKTOP_AUDIO_FRAME) return;
      // Cut to whole samples: pcm16 is two bytes each, and a trailing half sample would
      // throw on the audio thread rather than play as one bad sample.
      const samples = (data.byteLength - HEADER_BYTES) >> 1;
      onAudioRef.current(data.slice(HEADER_BYTES, HEADER_BYTES + samples * 2));
    };

    return () => {
      disposed = true;
      clearTimeout(reconnect);
      wsRef.current = null;
      canvasRef.current = null;
      canvas.close();
      setHasScreen(false);
      setLastFrame(null);
      ws.close();
    };
  }, [enabled, connection]);

  const sendInput = useCallback((frame: PageFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  return { clientId, state, screenRef, hasScreen, lastFrame, message, sendInput };
}
