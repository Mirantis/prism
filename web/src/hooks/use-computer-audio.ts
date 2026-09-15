import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoiceAudio, type VoiceAudio } from '@/lib/voice-audio';

export function useComputerAudio() {
  const audio = useRef<VoiceAudio | null>(null);
  const epoch = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      void audio.current?.stop();
      audio.current = null;
    },
    [],
  );
  const toggle = async () => {
    const current = ++epoch.current;
    if (audio.current) {
      await audio.current.stop();
      audio.current = null;
      setEnabled(false);
      return;
    }
    try {
      const playback = await startVoiceAudio({ sampleRate: 48_000, capture: false, onFrame() {} });
      if (current !== epoch.current) {
        await playback.stop();
        return;
      }
      audio.current = playback;
      setEnabled(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const enqueue = useCallback((frame: ArrayBuffer) => audio.current?.enqueueComputer(frame), []);
  return { enabled, error, toggle, enqueue };
}
