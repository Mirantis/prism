import { useCallback, useEffect, useRef, useState } from 'react';
import { computerWebSocketUrl } from '@/api/runtime-client';
import { canDecodeVideo, ScreenCanvas } from '@/lib/screen-canvas';

/**
 * The agent's screen, the sound of its desktop, and the user's hand on it.
 *
 * The call is not here: it is an ordinary voice chat on the chat socket, asked for with a
 * computer, and `useVoiceCall` runs it. This hook opens a second socket once that call is
 * live, because video several times a second would put a chat message behind it. It
 * carries the screen and the desktop's audio in, and the pointer, keyboard and the user's
 * shared screen out.
 *
 * The desktop's sound is handed to the call's own playback, so there is one audio path in
 * the page rather than two.
 */

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

type ServerFrame = ScreenStartFrame | ScreenPictureFrame | ErrorFrame;

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
  /** Open the socket only once the call is live and the session has a desktop. */
  enabled: boolean;
  /** The rectangle the page shows the screen in; a later change is sent as a frame. */
  viewport: Viewport | null;
  /** Where the desktop's sound goes: the call's own playback. */
  onAudio: (pcm: ArrayBuffer) => void;
}

export interface ComputerScreen {
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
  const { enabled, viewport, onAudio } = options;

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
  /** The size the socket opened with, so a later change is a change rather than a reopen. */
  const openedWith = useRef<Viewport | null>(null);

  useEffect(() => {
    if (!enabled) return;
    openedWith.current = viewport;
    const canvas = new ScreenCanvas(() => screenRef.current);
    canvasRef.current = canvas;

    const ws = new WebSocket(computerWebSocketUrl());
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const frame = JSON.parse(event.data) as ServerFrame;
        if (frame.type === 'screen_start') {
          if (frame.encoding === 'h264' && frame.codec) {
            // The call and its sound go on either way, so this is said rather than
            // treated as the call failing.
            if (!canDecodeVideo()) {
              setMessage('This browser cannot show the agent’s screen; the call still works.');
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
      wsRef.current = null;
      canvasRef.current = null;
      canvas.close();
      setHasScreen(false);
      setLastFrame(null);
      ws.close();
    };
    // `viewport` is read once here, at open; later sizes go as frames below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Later sizes go as frames. The box settles them before reporting, so each one here is
  // a size the user stopped at rather than a step of a drag.
  useEffect(() => {
    const ws = wsRef.current;
    if (!viewport || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (
      viewport.width === openedWith.current?.width &&
      viewport.height === openedWith.current?.height
    ) {
      return;
    }
    ws.send(JSON.stringify({ type: 'viewport', ...viewport }));
  }, [viewport]);

  const sendInput = useCallback((frame: PageFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  return { screenRef, hasScreen, lastFrame, message, sendInput };
}
