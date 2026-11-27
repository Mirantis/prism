import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageFrame } from './use-computer-screen';

/**
 * Sharing the user's own screen with the agent, the way a call shares it.
 *
 * `getDisplayMedia` opens the browser's own picker, which offers a screen, a window or a
 * tab. The stream is drawn into a canvas once a second and sent to the runtime as a JPEG
 * at most `MAX_WIDTH` wide, where the agent can look at the latest one. The browser's own
 * "Stop sharing" bar ends the track, which ends the share here too.
 */

const FRAME_INTERVAL_MS = 1000;
/** How long the video gets to report a size before the first picture is taken. */
const FIRST_FRAME_MS = 300;
export const MAX_WIDTH = 1280;
export const JPEG_QUALITY = 0.6;

interface ShareSession {
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  timer: number;
  /** The first picture, taken sooner than the timer's first tick. */
  firstFrame: number;
}

export function useScreenShare(send: (frame: PageFrame) => void) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<ShareSession | null>(null);
  /**
   * False once the page is gone.
   *
   * The picker is the user's own dialog and stays open for as long as they take over it,
   * which is long enough to leave the page. The stream then arrives with nothing left to
   * clean it up, and the browser goes on capturing their screen.
   */
  const mountedRef = useRef(true);
  /**
   * A stream the browser has handed over that is not a session yet.
   *
   * Starting one spans two awaits — the picker, then the video reporting a size — and the
   * capture is live for both. Held here across the second so that leaving the page, or
   * pressing stop, has something to stop: a cleanup that only knows about sessions would
   * leave the user's screen being captured with nothing left to end it.
   */
  const pendingRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    // A start that has not published yet is cancelled here too. Nothing was announced for
    // it, so there is nothing to say afterwards; the start itself sees the claim gone and
    // lets its stream go.
    const pending = pendingRef.current;
    if (pending) {
      pendingRef.current = null;
      pending.getTracks().forEach((t) => t.stop());
    }
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    clearInterval(session.timer);
    clearTimeout(session.firstFrame);
    session.stream.getTracks().forEach((t) => t.stop());
    session.video.srcObject = null;
    setStream(null);
    send({ type: 'user_screen_stopped' });
  }, [send]);

  /** Answers the stream it opened, so a caller that wants to record it has it at once. */
  const start = useCallback(async (): Promise<MediaStream | null> => {
    if (sessionRef.current) return sessionRef.current.stream;
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
    } catch (err) {
      // Closing the picker without choosing is not an error worth a message.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
        setError(err instanceof Error ? err.message : 'Could not share the screen.');
      }
      return null;
    }

    if (!mountedRef.current) {
      media.getTracks().forEach((t) => t.stop());
      return null;
    }

    // Claimed before the next await, so a page that closes while the video is starting
    // stops this capture rather than leaving it running for nobody.
    pendingRef.current = media;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = media;
    await video.play().catch(() => undefined);

    // The page went away, or something else took the claim: stop the capture rather than
    // setting timers and announcing a share nobody asked for any more.
    if (!mountedRef.current || pendingRef.current !== media) {
      media.getTracks().forEach((t) => t.stop());
      return null;
    }
    pendingRef.current = null;

    const canvas = document.createElement('canvas');

    const capture = () => {
      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) return;
      const scale = Math.min(1, MAX_WIDTH / videoWidth);
      const width = Math.round(videoWidth * scale);
      const height = Math.round(videoHeight * scale);
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);
      const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      send({ type: 'user_screen', data: url.slice(url.indexOf(',') + 1), width, height });
    };

    const timer = window.setInterval(capture, FRAME_INTERVAL_MS);
    // The first frame as soon as the video has a size, rather than a second from now.
    // Held so that a share ending inside those milliseconds does not send a picture after
    // saying it stopped, which would leave the agent holding a screen nobody is sharing.
    const firstFrame = window.setTimeout(capture, FIRST_FRAME_MS);
    sessionRef.current = { stream: media, video, canvas, timer, firstFrame };
    media.getVideoTracks()[0]?.addEventListener('ended', stop);
    setStream(media);
    setError(null);
    send({ type: 'user_screen_started' });
    return media;
  }, [send, stop]);

  useEffect(() => {
    // Set on the way in as well as cleared on the way out. In development React mounts,
    // unmounts and mounts again to shake out exactly this kind of state, and a flag only
    // ever cleared would stay cleared for the life of the page: every share would stop
    // itself the moment the picker handed one over.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.getTracks().forEach((t) => t.stop());
      const session = sessionRef.current;
      if (!session) return;
      clearInterval(session.timer);
      clearTimeout(session.firstFrame);
      session.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { sharing: stream !== null, stream, error, start, stop };
}
