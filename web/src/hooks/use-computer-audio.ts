import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoiceAudio, type VoiceAudio } from '@/lib/voice-audio';

export function useComputerAudio() {
  const audio = useRef<VoiceAudio | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let playback: VoiceAudio | null = null;
    const resume = () => playback?.resume();
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
    void startVoiceAudio({ sampleRate: 48_000, capture: false, onFrame() {} })
      .then((started) => {
        if (disposed) {
          void started.stop();
          return;
        }
        playback = started;
        audio.current = started;
      })
      .catch((err) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setEnabled(false);
      });
    return () => {
      disposed = true;
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      audio.current = null;
      void playback?.stop();
    };
  }, [enabled]);
  const toggle = () => {
    setError(null);
    // Dropped before the context is torn down, which is asynchronous: without this the
    // desktop plays on out of the buffer while the button already says it is off.
    if (enabled) audio.current?.clear();
    setEnabled((value) => !value);
  };
  const enqueue = useCallback((frame: ArrayBuffer) => audio.current?.enqueueComputer(frame), []);
  return { enabled, error, toggle, enqueue };
}
