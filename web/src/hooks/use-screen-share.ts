import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageFrame } from './use-voice-chat';

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
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.6;

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

  const stop = useCallback(() => {
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

  const start = useCallback(async () => {
    if (sessionRef.current) return;
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
      return;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = media;
    await video.play().catch(() => undefined);
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
  }, [send, stop]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (!session) return;
      clearInterval(session.timer);
      clearTimeout(session.firstFrame);
      session.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return { sharing: stream !== null, stream, error, start, stop };
}
