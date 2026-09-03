import { useEffect, useRef } from 'react';

interface SharePreviewProps {
  /** The screen, window or tab the user is sharing. */
  stream: MediaStream;
}

/** A small live view of what the user is sharing, with the label a call would show. */
export function SharePreview({ stream }: SharePreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="overflow-hidden rounded-md bg-black ring-2 ring-sky-400 shadow-lg">
      <video ref={videoRef} muted playsInline className="block w-44 bg-black" />
      <p className="bg-sky-500 px-2 py-0.5 text-center text-xs font-medium text-white">
        You're sharing your screen
      </p>
    </div>
  );
}
