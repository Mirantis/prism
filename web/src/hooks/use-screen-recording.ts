import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageFrame } from './use-computer-screen';
import {
  capFrames,
  hasChanged,
  MAX_FRAMES,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  type KeptFrame,
} from '@/lib/recording-frames';

/**
 * Recording the screen the user is sharing, with the words they say over it.
 *
 * The stream is sampled four times a second and the samples that show a changed screen
 * are kept as JPEGs, which go to the runtime when the recording stops. Nothing is encoded
 * as video: what the agent is given is pictures and the narration the call already
 * carries, so a video file would be made only to be taken apart again.
 *
 * The narration itself is not sent from here. The runtime diverts the call's own
 * microphone into the recording between `recording_started` and `recording_stopped`,
 * which is what keeps the agent from answering over the demonstration.
 *
 * `onEnded` runs however a recording ends. The page stops the share there, since the
 * share was opened to be recorded.
 */

/** How often the shared screen is looked at. Four times a second catches a click. */
const SAMPLE_INTERVAL_MS = 250;
/** The first look, sooner than the timer's first tick, once the video has a size. */
const FIRST_SAMPLE_MS = 200;
/** The longest recording. The runtime holds the same limit and is the one that binds. */
export const MAX_RECORDING_MS = 5 * 60_000;
/** The widest picture sent, and how hard it is compressed — as the live share uses. */
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.6;

/** Why a recording ended. */
type EndReason = 'user' | 'limit' | 'share_ended';

interface RecordingSession {
  stream: MediaStream;
  video: HTMLVideoElement;
  thumbCanvas: HTMLCanvasElement;
  frameCanvas: HTMLCanvasElement;
  timer: number;
  firstSample: number;
  startedAt: number;
  kept: KeptFrame[];
  /** The grey copy of the newest kept picture, which the next sample is judged against. */
  lastThumb: Uint8ClampedArray | null;
  onTrackEnded: () => void;
}

export interface ScreenRecordingControls {
  recording: boolean;
  /** How long the running recording has been going, for the page to show. */
  elapsedMs: number;
  error: string | null;
  start: (stream: MediaStream) => void;
  stop: () => void;
  /** End a recording that cannot be handed over, and say why on the page. */
  abandon: (why: string) => void;
}

/** The grey copy a sample is judged by: one byte a pixel, from the RGBA the canvas gives. */
function toGrey(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < grey.length; i++) {
    const p = i * 4;
    grey[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return grey;
}

export function useScreenRecording(
  send: (frame: PageFrame) => void,
  onEnded: () => void,
): ScreenRecordingControls {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  /** False once the page is gone; see `use-screen-share.ts` for why it is set both ways. */
  const mountedRef = useRef(true);

  /** Drop the timers and the stream listener. The stream itself belongs to the share. */
  const release = useCallback((session: RecordingSession) => {
    clearInterval(session.timer);
    clearTimeout(session.firstSample);
    session.stream.getVideoTracks()[0]?.removeEventListener('ended', session.onTrackEnded);
    session.video.srcObject = null;
  }, []);

  const finish = useCallback(
    (reason: EndReason) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      release(session);
      const ms = Date.now() - session.startedAt;
      for (const frame of session.kept) {
        send({ type: 'recording_frame', data: frame.data, at: frame.at });
      }
      send({ type: 'recording_stopped', ms, reason });
      onEnded();
      if (!mountedRef.current) return;
      setRecording(false);
      setElapsed(0);
    },
    [onEnded, release, send],
  );

  const start = useCallback(
    (stream: MediaStream) => {
      if (sessionRef.current) return;
      const track = stream.getVideoTracks()[0];
      if (!track) {
        setError('That screen has no picture to record.');
        return;
      }

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      void video.play().catch(() => undefined);

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = THUMB_WIDTH;
      thumbCanvas.height = THUMB_HEIGHT;
      const frameCanvas = document.createElement('canvas');

      const sample = () => {
        const session = sessionRef.current;
        if (!session) return;
        const { videoWidth, videoHeight } = video;
        if (!videoWidth || !videoHeight) return;

        const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
        if (!thumbCtx) return;
        thumbCtx.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
        const thumb = toGrey(thumbCtx.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data);

        const at = Date.now() - session.startedAt;
        if (hasChanged(session.lastThumb, thumb)) {
          const scale = Math.min(1, MAX_WIDTH / videoWidth);
          frameCanvas.width = Math.round(videoWidth * scale);
          frameCanvas.height = Math.round(videoHeight * scale);
          const frameCtx = frameCanvas.getContext('2d');
          if (frameCtx) {
            frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
            const url = frameCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
            session.kept.push({ data: url.slice(url.indexOf(',') + 1), at, thumb });
            session.kept = capFrames(session.kept, MAX_FRAMES);
            session.lastThumb = thumb;
          }
        }

        if (mountedRef.current) setElapsed(Math.floor(at / 1000) * 1000);
        if (at >= MAX_RECORDING_MS) finish('limit');
      };

      const onTrackEnded = () => finish('share_ended');
      track.addEventListener('ended', onTrackEnded);

      sessionRef.current = {
        stream,
        video,
        thumbCanvas,
        frameCanvas,
        timer: window.setInterval(sample, SAMPLE_INTERVAL_MS),
        firstSample: window.setTimeout(sample, FIRST_SAMPLE_MS),
        startedAt: Date.now(),
        kept: [],
        lastThumb: null,
        onTrackEnded,
      };
      setRecording(true);
      setElapsed(0);
      setError(null);
      send({ type: 'recording_started' });
    },
    [finish, send],
  );

  const stop = useCallback(() => finish('user'), [finish]);

  /**
   * Drop a recording that has nowhere to go.
   *
   * The pictures travel the screen's socket, and that socket does not come back once it
   * closes — the runtime closes it whenever another tab takes the screen. Carrying on
   * would fill the tab with pictures nobody will receive and hold the microphone until
   * the length limit, so it ends here and the page says so.
   */
  const abandon = useCallback(
    (why: string) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      release(session);
      send({ type: 'recording_cancelled' });
      onEnded();
      if (!mountedRef.current) return;
      setRecording(false);
      setElapsed(0);
      setError(why);
    },
    [onEnded, release, send],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (!session) return;
      // Leaving the page abandons the recording rather than handing it over: the call it
      // was made for is ending with the page, so there is nobody left to watch it.
      sessionRef.current = null;
      release(session);
      send({ type: 'recording_cancelled' });
    };
  }, [release, send]);

  return { recording, elapsedMs, error, start, stop, abandon };
}
