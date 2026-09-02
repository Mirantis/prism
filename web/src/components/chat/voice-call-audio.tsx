import { useEffect, useRef } from 'react';

/**
 * The agent's side of the call. Playing it needs no audio code of ours: the browser
 * decodes and plays the track the peer connection received, and nothing here
 * resamples, re-frames or records it.
 */
export default function VoiceCallAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  // Autoplay is allowed: a call only starts from a click, so the page has the user
  // activation the browser asks for.
  return <audio ref={ref} autoPlay className="hidden" data-testid="voice-call-audio" />;
}
